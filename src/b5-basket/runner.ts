/**
 * B5 basket runner: 5m/15m BTC/ETH, dynamic sizing from highest balance seen,
 * FOK buys, tiered limit sells, sell monitor. All CLOB/order traffic through proxy.
 */

import 'dotenv/config';
import {
  createPolyClobClient,
  getPolyClobConfigFromEnv,
  getOrCreateDerivedPolyClient,
} from '../polymarket/clob.js';
import {
  Side,
  OrderType,
  type ClobClient,
  type CreateOrderOptions,
} from '@polymarket/clob-client';
import { B5_CONFIG } from './config.js';
import {
  getUSDCBalance,
  getMaxBalanceForSizing,
  loadMaxBalance,
} from './balance.js';
import { discoverB5MarketsBySlug, type B5Candidate } from './markets.js';
import { fetchBinance1m, estimateProb } from './edge-engine.js';
import { getB5MinEdgeFromSupabase, logB5Loss } from './supabase-b5.js';

const WALLET = process.env.POLYMARKET_PROXY_WALLET?.trim() ||
  process.env.POLYMARKET_FUNDER?.trim() ||
  '';
const SCAN_INTERVAL_MS = B5_CONFIG.scanIntervalSeconds * 1000;

/** Seconds into the 5-min window for slug btc-updown-5m-{unixStart}. Returns null for 15min slugs. */
function secondsInto5minWindow(slug: string, now: Date): number | null {
  const m = slug.match(/-5m-(\d+)$/);
  if (!m) return null;
  const startUnix = parseInt(m[1], 10);
  return now.getTime() / 1000 - startUnix;
}
const SELL_MONITOR_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Proxy (same pattern as B4 — required for orders)
// ---------------------------------------------------------------------------

async function withPolyProxy<T>(fn: () => Promise<T>): Promise<T> {
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '';
  if (!proxy) return fn();
  const axios = (await import('axios')).default;
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  const prevUndici = (await import('undici')).getGlobalDispatcher();
  const { setGlobalDispatcher, ProxyAgent } = await import('undici');
  const prevAxiosAgent = axios.defaults.httpsAgent;
  const prevAxiosProxy = axios.defaults.proxy;
  try {
    setGlobalDispatcher(new ProxyAgent(proxy));
    axios.defaults.httpsAgent = new HttpsProxyAgent(proxy);
    axios.defaults.proxy = false;
    return await fn();
  } finally {
    setGlobalDispatcher(prevUndici);
    axios.defaults.httpsAgent = prevAxiosAgent;
    axios.defaults.proxy = prevAxiosProxy;
  }
}

async function getClobClient(): Promise<ClobClient> {
  const cfg = getPolyClobConfigFromEnv();
  return cfg != null ? createPolyClobClient(cfg) : await getOrCreateDerivedPolyClient();
}

function parseMid(raw: unknown): number {
  if (typeof raw === 'string') return parseFloat(raw);
  if (typeof raw === 'number') return raw;
  if (raw && typeof raw === 'object' && 'mid' in raw) return parseFloat(String((raw as { mid: string }).mid));
  return 0;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface OpenPosition {
  tokenId: string;
  buyPrice: number;
  shares: number;
  question: string;
  tickSize: CreateOrderOptions['tickSize'];
  negRisk: boolean;
  edge_at_entry: number;
  slug?: string;
}

const positions = new Map<string, OpenPosition>();
let dailyStartBalance = 0;
let dailyStartDate = '';

// ---------------------------------------------------------------------------
// Sizing from highest balance seen
// ---------------------------------------------------------------------------

/** Per-leg size ($5 min). Basket is capped at 4 legs only, no dollar cap. */
function computeSizing(maxBalanceSeen: number): { positionSizeUSD: number } {
  const positionSizeUSD = Math.max(
    B5_CONFIG.minPositionUsd,
    Math.min(B5_CONFIG.positionSizeCap, maxBalanceSeen * B5_CONFIG.riskPerLeg)
  );
  return { positionSizeUSD };
}

// ---------------------------------------------------------------------------
// Daily loss check
// ---------------------------------------------------------------------------

function checkDailyLossLimit(currentBalance: number): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailyStartDate) {
    dailyStartDate = today;
    dailyStartBalance = currentBalance;
  }
  if (dailyStartBalance <= 0) return false;
  const pnlPct = (currentBalance - dailyStartBalance) / dailyStartBalance;
  return pnlPct < B5_CONFIG.dailyLossLimit;
}

// ---------------------------------------------------------------------------
// Place FOK market buy
// ---------------------------------------------------------------------------

async function placeFokBuy(
  client: ClobClient,
  tokenId: string,
  amountUsd: number,
  tickSize: CreateOrderOptions['tickSize'],
  negRisk: boolean
): Promise<{ orderId?: string; shares?: number; error?: string }> {
  try {
    const result = await client.createAndPostMarketOrder(
      { tokenID: tokenId, amount: amountUsd, side: Side.BUY },
      { tickSize, negRisk },
      OrderType.FOK
    );
    const orderId = (result as { orderID?: string; orderId?: string })?.orderID
      ?? (result as { orderId?: string })?.orderId;
    if (!orderId) return { error: `No orderId: ${JSON.stringify(result)}` };
    const mid = parseMid(await client.getMidpoint(tokenId));
    const shares = mid > 0 ? Math.max(1, Math.ceil(amountUsd / mid)) : 0;
    return { orderId, shares };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Place GTC limit sell (size in integer shares)
// ---------------------------------------------------------------------------

async function placeLimitSell(
  client: ClobClient,
  tokenId: string,
  price: number,
  sizeShares: number,
  tickSize: CreateOrderOptions['tickSize'],
  negRisk: boolean
): Promise<{ orderId?: string; error?: string }> {
  if (sizeShares < 1) return {};
  const tickDec = String(tickSize).split('.')[1]?.length ?? 2;
  const factor = 10 ** tickDec;
  const roundedPrice = Math.round(price * factor) / factor;
  try {
    const result = await client.createAndPostOrder(
      { tokenID: tokenId, price: roundedPrice, size: sizeShares, side: Side.SELL },
      { tickSize, negRisk },
      OrderType.GTC
    );
    const orderId = (result as { orderID?: string; orderId?: string })?.orderID
      ?? (result as { orderId?: string })?.orderId;
    return orderId ? { orderId } : { error: `No orderId: ${JSON.stringify(result)}` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Sell monitor: FOK sell remainder if mid > 1.6 * buyPrice
// ---------------------------------------------------------------------------

async function runSellMonitor(): Promise<void> {
  if (positions.size === 0) return;
  await withPolyProxy(async () => {
    const client = await getClobClient();
    for (const [tokenId, pos] of positions.entries()) {
      try {
        const mid = parseMid(await client.getMidpoint(tokenId));
        if (mid <= 0) continue;
        if (mid < pos.buyPrice * 1.6) continue;
        const sellShares = Math.max(1, Math.ceil(pos.shares));
        const isLoss = mid < pos.buyPrice;
        console.log(`[B5] Sell monitor: selling ${sellShares} @ ${mid.toFixed(3)} (${pos.question.slice(0, 40)}…)${isLoss ? ' [LOSS]' : ''}`);
        const result = await client.createAndPostMarketOrder(
          { tokenID: tokenId, amount: sellShares, side: Side.SELL },
          { tickSize: pos.tickSize, negRisk: pos.negRisk },
          OrderType.FOK
        );
        const orderId = (result as { orderID?: string; orderId?: string })?.orderID ?? (result as { orderId?: string })?.orderId;
        if (orderId) {
          if (isLoss) {
            await logB5Loss({ edge_at_entry: pos.edge_at_entry, question: pos.question, slug: pos.slug });
          }
          positions.delete(tokenId);
          console.log(`[B5] Sold: ${tokenId.slice(0, 16)}…`);
        }
      } catch (e) {
        console.warn('[B5] Sell monitor error:', e instanceof Error ? e.message : e);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Main scan: discover → edge → basket → buy → tiered sells
// ---------------------------------------------------------------------------

async function runOneScan(): Promise<void> {
  if (!WALLET) {
    console.warn('[B5] No POLYMARKET_FUNDER / POLYMARKET_PROXY_WALLET');
    return;
  }

  const { balance, maxForSizing } = await getMaxBalanceForSizing(WALLET);
  const { positionSizeUSD } = computeSizing(maxForSizing);
  if (checkDailyLossLimit(balance)) {
    console.log(`[B5] Daily loss limit hit (balance ${balance.toFixed(2)}, daily start ${dailyStartBalance.toFixed(2)}) — skipping scan`);
    return;
  }

  const now = new Date();
  // Binance: fetch direct (proxy can break Binance). Gamma + CLOB: use proxy (like D1).
  const [btcCandles, ethCandles] = await Promise.all([
    fetchBinance1m('BTCUSDT', 120),
    fetchBinance1m('ETHUSDT', 120).catch(() => null),
  ]);

  const minEdgeFromSupabase = await getB5MinEdgeFromSupabase();
  const minEdge = minEdgeFromSupabase ?? B5_CONFIG.minEdge;
  if (minEdgeFromSupabase == null) {
    console.log(`[B5] min_edge from Supabase: (none) — using default ${minEdge} (set SUPABASE_URL + SUPABASE_ANON_KEY on D3 to use dashboard value)`);
  } else {
    console.log(`[B5] min_edge from Supabase: ${minEdge}`);
  }

  await withPolyProxy(async () => {
    const allOutcomes = await discoverB5MarketsBySlug(now, B5_CONFIG.cheapThreshold, true);
    // Refresh prices from CLOB midpoint (live order book) so we don't rely on Gamma's delayed outcomePrices
    const client = await getClobClient();
    for (const c of allOutcomes) {
      try {
        const mid = parseMid(await client.getMidpoint(c.tokenId));
        if (mid > 0 && mid < 1) c.price = mid;
      } catch {
        // keep Gamma price if CLOB fails
      }
    }
    const rawCandidates = allOutcomes.filter((c) => c.price < B5_CONFIG.cheapThreshold);
    console.log(`[B5] Raw candidates (price < ${B5_CONFIG.cheapThreshold}): ${rawCandidates.length}`);

    const candidates: B5Candidate[] = [];
    for (const c of allOutcomes) {
      const symbol = c.question.startsWith('ETH') ? 'ETH' : 'BTC';
      const estP = estimateProb(c.question, btcCandles, ethCandles, symbol);
      const edge = estP - c.price;
      const passCheap = c.price < B5_CONFIG.cheapThreshold;
      const passEdge = edge >= minEdge;
      console.log(
        `[B5] Edge ${c.question}: price=${c.price.toFixed(3)} estP=${estP.toFixed(3)} edge=${edge.toFixed(3)} (cheap? ${passCheap} edge≥${minEdge}? ${passEdge})`
      );
      if (!passCheap || edge < minEdge) continue;
      // Skip 5-min outcomes when already >2.5 min into window (catch early edges only)
      if (c.timeframe === '5min') {
        const secInto = secondsInto5minWindow(c.slug, now);
        if (secInto != null && secInto > B5_CONFIG.max5minSecondsIntoWindow) continue;
      }
      candidates.push({ ...c, estP, edge });
    }

    candidates.sort((a, b) => a.price - b.price);
    const strong5min = candidates.filter((c) => c.timeframe === '5min' && c.edge >= B5_CONFIG.strong5minEdge);
    const strong15min = candidates.filter((c) => c.timeframe === '15min' && c.edge >= B5_CONFIG.strong15minEdge);
    const normalCandidates = candidates.filter((c) => c.edge >= B5_CONFIG.minEdge);

    let basket: B5Candidate[] = [];
    let perLegMaxUsd = 0; // 0 = normal (orderMinSize×price); solo 5m=1.0, solo 15m=1.5
    if (strong5min.length >= 1) {
      basket = [strong5min[0]];
      perLegMaxUsd = 1.0;
      console.log(`[B5] Basket: 1 leg (solo 5-min, edge ${strong5min[0].edge.toFixed(3)} ≥ ${B5_CONFIG.strong5minEdge})`);
    } else if (strong15min.length >= 1) {
      basket = [strong15min[0]];
      perLegMaxUsd = 1.5;
      console.log(`[B5] Basket: 1 leg (solo 15-min, edge ${strong15min[0].edge.toFixed(3)} ≥ ${B5_CONFIG.strong15minEdge})`);
    } else if (normalCandidates.length >= 2) {
      const maxBasketUSD = B5_CONFIG.maxBasketCostCap;
      let totalCost = 0;
      for (const c of normalCandidates) {
        if (basket.length >= 4) break;
        const legCost = Math.max(0.25, (c.market.orderMinSize ?? 5) * c.price);
        if (totalCost + legCost > maxBasketUSD) break;
        basket.push(c);
        totalCost += legCost;
      }
      perLegMaxUsd = 0; // use orderMinSize×price per leg, no dollar cap
      console.log(`[B5] Basket: ${basket.length} legs, ~$${totalCost.toFixed(2)} total (normal multi-leg, max $${maxBasketUSD})`);
    }

    if (basket.length === 0) {
      console.log(`[B5] Scan: ${candidates.length} candidates, no basket`);
      return;
    }

    for (const c of basket) {
      const tickSize: CreateOrderOptions['tickSize'] =
        (c.market.orderPriceMinTickSize ? String(c.market.orderPriceMinTickSize) : '0.01') as CreateOrderOptions['tickSize'];
      const negRisk = c.market.negRisk ?? false;
      const minOrderUsd = (c.market.orderMinSize ?? 5) * c.price;
      const amountUsd = perLegMaxUsd > 0
        ? Math.max(minOrderUsd, perLegMaxUsd)
        : Math.max(0.25, minOrderUsd);

      const buyResult = await placeFokBuy(client, c.tokenId, amountUsd, tickSize, negRisk);
      if (buyResult.error) {
        console.warn(`[B5] Buy failed: ${c.question.slice(0, 40)} — ${buyResult.error}`);
        continue;
      }

      const shares = buyResult.shares ?? Math.max(1, Math.ceil(amountUsd / c.price));
      positions.set(c.tokenId, {
        tokenId: c.tokenId,
        buyPrice: c.price,
        shares,
        question: c.question,
        tickSize,
        negRisk,
        edge_at_entry: c.edge,
        slug: c.slug,
      });

      console.log(`[B5] BOUGHT ${c.question.slice(0, 50)}… @ ${c.price} | ~${shares} shares`);

      const tierSizes = [0.3, 0.3, 0.3].map((pct) => Math.max(1, Math.ceil(shares * pct)));
      const tiers = [
        { mult: 1.8, size: tierSizes[0] },
        { mult: 3, size: tierSizes[1] },
        { mult: 5, size: tierSizes[2] },
      ];
      for (const t of tiers) {
        const sellPrice = Math.min(0.99, c.price * t.mult);
        if (sellPrice >= 0.99) continue;
        await placeLimitSell(client, c.tokenId, sellPrice, t.size, tickSize, negRisk);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function startB5Runner(): Promise<void> {
  console.log('[B5] Basket runner starting (5m/15m BTC/ETH, dynamic sizing from highest balance seen)');
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '';
  if (!proxy) {
    console.warn('[B5] No HTTPS_PROXY set — set it like D1/D2 or orders may fail (geo-block).');
  } else {
    console.log('[B5] Proxy set (orders and Gamma/Binance via proxy)');
  }
  loadMaxBalance();
  if (WALLET) {
    const { balance, maxForSizing } = await getMaxBalanceForSizing(WALLET);
    console.log(`[B5] Wallet ${WALLET.slice(0, 10)}… balance=$${balance.toFixed(2)} maxForSizing=$${maxForSizing.toFixed(2)}`);
  }

  let sellMonitorTimer: ReturnType<typeof setInterval> | null = null;

  const runScan = () => {
    runOneScan().catch((e) => console.error('[B5] scan error:', e));
  };

  runScan();
  const scanTimer = setInterval(runScan, SCAN_INTERVAL_MS);

  sellMonitorTimer = setInterval(() => {
    runSellMonitor().catch((e) => console.warn('[B5] sell monitor error:', e));
  }, SELL_MONITOR_INTERVAL_MS);

  const shutdown = () => {
    if (scanTimer) clearInterval(scanTimer);
    if (sellMonitorTimer) clearInterval(sellMonitorTimer);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
