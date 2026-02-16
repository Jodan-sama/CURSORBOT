/**
 * B5 Spread Runner — Live 5-Minute BTC Spread Strategy
 *
 * Adapted from B1/B2/B3 (15-min Kalshi) for Polymarket 5-minute markets.
 * Uses spread between current Chainlink BTC price and window open price.
 *
 * Three tiers (scaled from 15-min to 5-min via sqrt(5/15) ≈ 0.577):
 *
 *   B5-T1: spread > 0.12%, entry after 250s (last 50s), limit 96c
 *   B5-T2: spread > 0.33%, entry after 200s (last 100s), limit 97c
 *   B5-T3: spread > 0.58%, entry after 140s (last 160s), limit 97c
 *
 * Positions resolve at window end (no early exit). Hold until $1 or $0.
 * Orders placed via Polymarket CLOB (GTC limit orders).
 */

import 'dotenv/config';
import { PriceFeed, getChainlinkPrice } from './price-feed.js';
import {
  getWindowStart,
  msUntilWindowEnd,
  getPolySlug5m,
  secondsIntoWindow,
} from './clock.js';
import {
  isB4EmergencyOff,
  logError,
  logPosition,
} from '../db/supabase.js';
import {
  createPolyClobClient,
  getPolyClobConfigFromEnv,
  getOrCreateDerivedPolyClient,
} from '../polymarket/clob.js';
import { getPolyMarketBySlug } from '../polymarket/gamma.js';
import {
  Side,
  OrderType,
  type ClobClient,
  type CreateOrderOptions,
} from '@polymarket/clob-client';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const POSITION_SIZE_USD = parseFloat(process.env.B5_POSITION_SIZE || '5');
const TICK_INTERVAL_MS = 3_000;

// Spread tiers (adapted from B1/B2/B3 for 5-minute windows)
const TIERS = [
  { name: 'B5-T1', spreadPct: 0.12, entryAfterSec: 250, limitPrice: 0.96 },
  { name: 'B5-T2', spreadPct: 0.33, entryAfterSec: 200, limitPrice: 0.97 },
  { name: 'B5-T3', spreadPct: 0.58, entryAfterSec: 140, limitPrice: 0.97 },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenOrder {
  tier: string;
  direction: 'up' | 'down';
  side: 'yes' | 'no';
  tokenId: string;
  orderId: string;
  limitPrice: number;
  size: number;
  slug: string;
  windowStart: number;
  spreadAtEntry: number;
  btcPriceAtEntry: number;
  windowOpenPrice: number;
  negRisk: boolean;
  tickSize: CreateOrderOptions['tickSize'];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const openOrders: OpenOrder[] = [];
let currentWindowStart = 0;
const placedThisWindow = new Set<string>();
let totalTrades = 0;
let totalWins = 0;
let totalLosses = 0;
let totalPnl = 0;

// ---------------------------------------------------------------------------
// Proxy wrapper
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

// ---------------------------------------------------------------------------
// Place limit order (GTC — stays in the book until filled or cancelled)
// ---------------------------------------------------------------------------

async function placeLimitOrder(
  slug: string,
  side: 'yes' | 'no',
  limitPrice: number,
  size: number,
): Promise<{ orderId?: string; tokenId?: string; negRisk?: boolean; tickSize?: CreateOrderOptions['tickSize']; error?: string }> {
  try {
    return await withPolyProxy(async () => {
      const market = await getPolyMarketBySlug(slug);
      if (!market) return { error: `Market not found: ${slug}` };

      const tokenId = side === 'yes' ? market.clobTokenIds[0] : market.clobTokenIds[1];
      if (!tokenId) return { error: `No ${side} token for ${slug}` };

      const client = await getClobClient();

      const tickSize: CreateOrderOptions['tickSize'] =
        (market.orderPriceMinTickSize ? String(market.orderPriceMinTickSize) : '0.01') as CreateOrderOptions['tickSize'];

      // Round price to tick
      const tickDecimals = String(tickSize).split('.')[1]?.length ?? 2;
      const factor = 10 ** tickDecimals;
      const price = Math.round(limitPrice * factor) / factor;

      // Calculate shares: size in USDC / price
      const shares = Math.max(1, Math.floor(size / price));

      console.log(
        `[B5] LIMIT BUY ${side} price=${price} size=${shares} ($${size}) | ${slug}`,
      );

      const result = await client.createAndPostOrder(
        { tokenID: tokenId, price, size: shares, side: Side.BUY },
        { tickSize, negRisk: market.negRisk ?? false },
        OrderType.GTC,
      );

      const orderId = (result as { orderID?: string; orderId?: string })?.orderID
        ?? (result as { orderId?: string })?.orderId;

      if (!orderId) return { error: `No orderId in response: ${JSON.stringify(result)}` };
      return { orderId, tokenId, negRisk: market.negRisk ?? false, tickSize };
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Resolve positions at window end
// ---------------------------------------------------------------------------

async function resolveWindowEnd(btcPrice: number): Promise<void> {
  const toResolve = openOrders.filter(o => o.windowStart !== currentWindowStart);
  for (const order of toResolve) {
    const resolvedUp = btcPrice > order.windowOpenPrice;
    const won = (order.direction === 'up' && resolvedUp) || (order.direction === 'down' && !resolvedUp);
    const resolvePrice = won ? 1.0 : 0.0;

    // PnL: bought at limitPrice, resolved at 1.0 or 0.0
    const contracts = POSITION_SIZE_USD / order.limitPrice;
    const pnl = (resolvePrice - order.limitPrice) * contracts;

    totalTrades++;
    if (won) totalWins++; else totalLosses++;
    totalPnl += pnl;

    console.log(
      `[B5] RESOLVED ${order.tier}: ${order.direction} → ${resolvedUp ? 'UP' : 'DOWN'} → ${won ? 'WIN' : 'LOSS'} ` +
      `| BTC=$${btcPrice.toFixed(2)} vs open=$${order.windowOpenPrice.toFixed(2)} ` +
      `| PnL=$${pnl.toFixed(3)} | total=$${totalPnl.toFixed(2)} W/L=${totalWins}/${totalLosses}`,
    );

    // Log to Supabase
    try {
      await logPosition({
        bot: 'B4',
        asset: 'BTC',
        venue: 'polymarket',
        strike_spread_pct: order.spreadAtEntry,
        position_size: POSITION_SIZE_USD,
        ticker_or_slug: order.slug,
        order_id: order.orderId,
        raw: {
          strategy: 'spread-live',
          tier: order.tier,
          direction: order.direction,
          exitReason: won ? 'RESOLVED_WIN' : 'RESOLVED_LOSS',
          entryPrice: order.limitPrice,
          resolvePrice,
          pnl,
          won,
          entryBtcPrice: order.btcPriceAtEntry,
          exitBtcPrice: btcPrice,
          windowOpenPrice: order.windowOpenPrice,
          spreadAtEntry: order.spreadAtEntry,
          cumPnl: totalPnl,
          cumWins: totalWins,
          cumTrades: totalTrades,
        },
      });
    } catch { /* best effort */ }

    // Remove from tracking
    const idx = openOrders.indexOf(order);
    if (idx >= 0) openOrders.splice(idx, 1);
  }
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

async function runOneTick(feed: PriceFeed, tickCount: number): Promise<void> {
  const now = new Date();
  const windowStartMs = getWindowStart(now).getTime();
  const secInWindow = secondsIntoWindow(now);

  // New window → reset tracking
  if (windowStartMs !== currentWindowStart) {
    currentWindowStart = windowStartMs;
    placedThisWindow.clear();
    feed.setWindowOpen(windowStartMs);
  }

  const cl = getChainlinkPrice();
  const btcPrice = cl?.price ?? 0;
  if (btcPrice <= 0) return;

  // Resolve old-window positions
  await resolveWindowEnd(btcPrice);

  // B4-specific emergency off check (shared with B4 momentum bot)
  if (tickCount % 10 === 0) {
    try {
      if (await isB4EmergencyOff()) {
        if (tickCount % 100 === 0) console.log('[B5] emergency off — paused');
        return;
      }
    } catch { /* Supabase may not be configured */ }
  }

  // Calculate spread
  const windowOpenPrice = await feed.getWindowOpen();
  if (windowOpenPrice <= 0) return;

  const spreadPct = Math.abs((btcPrice - windowOpenPrice) / btcPrice * 100);
  const spreadDir: 'up' | 'down' = btcPrice > windowOpenPrice ? 'up' : 'down';
  const slug = getPolySlug5m(now);

  // Check each tier for entry
  for (const tier of TIERS) {
    const tierKey = `${tier.name}-${windowStartMs}`;
    if (placedThisWindow.has(tierKey)) continue;
    if (secInWindow < tier.entryAfterSec) continue;
    if (spreadPct < tier.spreadPct) continue;

    // Already have this tier open for this window
    if (openOrders.some(o => o.tier === tier.name && o.windowStart === windowStartMs)) continue;

    const side: 'yes' | 'no' = spreadDir === 'up' ? 'yes' : 'no';

    console.log(
      `[B5] SIGNAL ${tier.name}: spread=${spreadPct.toFixed(4)}% (threshold ${tier.spreadPct}%) ` +
      `| dir=${spreadDir} | limit=${tier.limitPrice} | ${secInWindow.toFixed(0)}s into window`,
    );

    const result = await placeLimitOrder(slug, side, tier.limitPrice, POSITION_SIZE_USD);

    if (result.orderId && result.tokenId) {
      placedThisWindow.add(tierKey);
      openOrders.push({
        tier: tier.name,
        direction: spreadDir,
        side,
        tokenId: result.tokenId,
        orderId: result.orderId,
        limitPrice: tier.limitPrice,
        size: POSITION_SIZE_USD,
        slug,
        windowStart: windowStartMs,
        spreadAtEntry: spreadPct,
        btcPriceAtEntry: btcPrice,
        windowOpenPrice,
        negRisk: result.negRisk ?? false,
        tickSize: result.tickSize ?? '0.01',
      });

      console.log(
        `[B5] PLACED ${tier.name}: ${spreadDir} at ${tier.limitPrice} ` +
        `| orderId=${result.orderId.slice(0, 12)}… ` +
        `| spread=${spreadPct.toFixed(4)}%`,
      );
    } else {
      console.log(`[B5] ${tier.name} order failed: ${result.error}`);
      try {
        await logError(new Error(result.error ?? 'order failed'), { bot: 'B5', tier: tier.name, slug, side });
      } catch { /* ignore */ }
    }
  }

  // Periodic status log
  if (tickCount % 20 === 0 && spreadPct > 0.01) {
    console.log(
      `[B5] spread: ${spreadPct.toFixed(4)}% ${spreadDir} ` +
      `| BTC=$${btcPrice.toFixed(2)} open=$${windowOpenPrice.toFixed(2)} ` +
      `| ${secInWindow.toFixed(0)}s in | open orders: ${openOrders.length}`,
    );
  }

  if (tickCount % 100 === 0) {
    console.log('');
    console.log(`[B5] ═══ Status @ ${new Date().toISOString()} ═══`);
    console.log(`[B5] BTC=$${btcPrice.toFixed(2)} | spread=${spreadPct.toFixed(4)}% ${spreadDir}`);
    console.log(`[B5] Trades: ${totalTrades} | W/L: ${totalWins}/${totalLosses} | PnL: $${totalPnl.toFixed(2)}`);
    console.log(`[B5] Open orders: ${openOrders.length}`);
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function startSpreadRunner(): Promise<void> {
  console.log('');
  console.log('[B5] ═══ Spread Runner Starting ═══');
  console.log(`[B5] Position size: $${POSITION_SIZE_USD}`);
  console.log('[B5] Tiers:');
  for (const t of TIERS) {
    console.log(`[B5]   ${t.name}: spread>${t.spreadPct}%, entry after ${t.entryAfterSec}s, limit ${t.limitPrice}`);
  }
  console.log('[B5] Strategy: buy at limit, hold to window resolution ($1 or $0)');
  console.log('');

  const feed = new PriceFeed();

  // Wait for Chainlink
  await new Promise((r) => setTimeout(r, 5_000));
  if (feed.isChainlinkLive()) {
    const cl = getChainlinkPrice();
    console.log(`[B5] Chainlink LIVE — BTC=$${cl?.price.toFixed(2) ?? '?'}`);
  } else {
    console.warn('[B5] Chainlink not connected yet — will keep trying');
  }

  let tickCount = 0;

  const runTick = async () => {
    tickCount++;
    try {
      await feed.refresh();
      await runOneTick(feed, tickCount);
    } catch (e) {
      console.error('[B5] tick error:', e instanceof Error ? e.message : e);
      try { await logError(e, { bot: 'B5', stage: 'tick' }); } catch { /* ignore */ }
    }
    setTimeout(runTick, TICK_INTERVAL_MS);
  };

  runTick();

  const shutdown = () => {
    console.log('');
    console.log('[B5] ═══ Final Results ═══');
    console.log(`[B5] Trades: ${totalTrades} | W/L: ${totalWins}/${totalLosses} | PnL: $${totalPnl.toFixed(2)}`);
    console.log(`[B5] Open orders at shutdown: ${openOrders.length} (will resolve when market settles)`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
