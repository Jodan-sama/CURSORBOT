/**
 * B5 Spread Runner — Live 5-Minute ETH/SOL/XRP Spread Strategy (D3)
 *
 * Full B4 parity: T2→T1 block 5 min, T3→T1+T2 block 15 min; early guard;
 * T3 window [100s, 180s). Per-asset tier spreads from b5_state.results_json.
 * One position size for all assets. Resolver on D2 uses .env.b5 (B5 wallet).
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { PriceFeed, getChainlinkPrice } from './price-feed.js';
import {
  getWindowStart,
  getPolySlug5m,
  secondsIntoWindow,
  B5_ASSETS,
  type B5Asset,
} from './clock.js';
import {
  isB5EmergencyOff,
  logError,
  logPosition,
  loadB5Config,
  getDb,
  getB5Blocks,
  updateB5TierBlocks,
  updateB5EarlyGuard,
  type B5TierConfig,
} from '../db/supabase.js';
import { getOrCreateDerivedPolyClient } from '../polymarket/clob.js';
import { getPolyMarketBySlug } from '../polymarket/gamma.js';
import {
  Side,
  OrderType,
  type ClobClient,
  type CreateOrderOptions,
} from '@polymarket/clob-client';

// ---------------------------------------------------------------------------
// Tier config (per-asset spreads from loadB5Config)
// ---------------------------------------------------------------------------

interface TierConfig {
  name: string;
  spreadPct: number;
  entryAfterSec: number;
  limitPrice: number;
}

/** B4 convention: T1 = lowest spread (enters last), T3 = highest spread (enters first, blocks T1+T2). Config stores high in eth_t1_spread and low in eth_t3_spread; we map so runner T1/T3 match B4. */
function getTiersForAsset(cfg: B5TierConfig, asset: B5Asset): TierConfig[] {
  const cfgHigh = asset === 'ETH' ? cfg.eth_t1_spread : asset === 'SOL' ? cfg.sol_t1_spread : cfg.xrp_t1_spread;
  const t2 = asset === 'ETH' ? cfg.eth_t2_spread : asset === 'SOL' ? cfg.sol_t2_spread : cfg.xrp_t2_spread;
  const cfgLow = asset === 'ETH' ? cfg.eth_t3_spread : asset === 'SOL' ? cfg.sol_t3_spread : cfg.xrp_t3_spread;
  return [
    { name: 'B5-T1', spreadPct: cfgLow, entryAfterSec: 250, limitPrice: 0.96 },   // T1 = lowest entry level (like B4)
    { name: 'B5-T2', spreadPct: t2, entryAfterSec: 180, limitPrice: 0.97 },
    { name: 'B5-T3', spreadPct: cfgHigh, entryAfterSec: 100, limitPrice: 0.97 },  // T3 = highest spread, blocks T1+T2
  ];
}

const MIN_TICK_DELAY_MS = 1_000;
const T3_WINDOW_END_SEC = 180;
const EARLY_GUARD_WINDOW_SEC = 100;
const EARLY_GUARD_CHECK_TICKS = 5;
const SPREAD_SAMPLE_SIZE = 10;
const CONFIG_CACHE_MS = 5 * 60 * 1000;

// Mutable config (refreshed from Supabase)
let b5Config: B5TierConfig = {
  eth_t1_spread: 0.32, eth_t2_spread: 0.181, eth_t3_spread: 0.110,
  sol_t1_spread: 0.32, sol_t2_spread: 0.206, sol_t3_spread: 0.121,
  xrp_t1_spread: 0.32, xrp_t2_spread: 0.206, xrp_t3_spread: 0.121,
  t2_block_min: 5, t3_block_min: 15, position_size: 5,
  early_guard_spread_pct: 0.45, early_guard_cooldown_min: 60,
};

let t2BlockMs = 5 * 60_000;
let t3BlockMs = 15 * 60_000;
let earlyGuardSpreadPct = 0.45;
let earlyGuardCooldownMs = 60 * 60_000;
let lastConfigRefreshMs = 0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenOrder {
  tier: string;
  asset: B5Asset;
  direction: 'up' | 'down';
  side: 'yes' | 'no';
  tokenId: string;
  orderId: string;
  limitPrice: number;
  size: number;
  slug: string;
  windowStart: number;
  spreadAtEntry: number;
  signedSpread: number;
  priceAtEntry: number;
  windowOpenPrice: number;
  negRisk: boolean;
  tickSize: CreateOrderOptions['tickSize'];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const openOrders: OpenOrder[] = [];
let currentWindowStart = 0;
const placedThisWindow = new Set<string>(); // e.g. B5-T1-{windowStartMs}-ETH

const spreadSampleBuffer: Map<B5Asset, number[]> = new Map();
const staleSpreadThisWindow: Map<B5Asset, boolean> = new Map();
let loggedNoChainlinkThisWindow: Map<B5Asset, boolean> = new Map();

const t1BlockedUntil: Record<B5Asset, number> = { ETH: 0, SOL: 0, XRP: 0 };
const t2BlockedUntil: Record<B5Asset, number> = { ETH: 0, SOL: 0, XRP: 0 };
let earlyGuardCooldownUntil = 0;

// ---------------------------------------------------------------------------
// Wallet balance polling
// ---------------------------------------------------------------------------

const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const WALLET_ADDRESS = process.env.POLYMARKET_PROXY_WALLET?.trim()
  ?? process.env.POLYMARKET_FUNDER?.trim()
  ?? '0x439BfEB801c12E63C8571Dffc04e74a8C3Dba6eb';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
const BALANCE_POLL_MS = 15 * 60_000;
let lastBalancePoll = 0;

async function pollWalletBalance(): Promise<void> {
  const now = Date.now();
  if (now - lastBalancePoll < BALANCE_POLL_MS) return;
  lastBalancePoll = now;
  try {
    const rpcUrl = process.env.POLYGON_RPC_URL?.trim() || 'https://polygon-mainnet.g.alchemy.com/v2/J6wjUKfJUdYzPD5QNDd-i';
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const usdc = new ethers.Contract(USDC_POLYGON, ERC20_ABI, provider);
    const raw = await usdc.balanceOf(WALLET_ADDRESS);
    const balance = Number(ethers.formatUnits(raw, 6));
    console.log(`[B5] wallet balance: $${balance.toFixed(2)}`);
    await getDb().from('b5_state').update({
      bankroll: balance,
      max_bankroll: balance,
      updated_at: new Date().toISOString(),
    }).eq('id', 'default');
  } catch (e) {
    console.warn('[B5] balance poll failed:', e instanceof Error ? e.message : e);
  }
}

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
  return getOrCreateDerivedPolyClient();
}

// ---------------------------------------------------------------------------
// Refresh config from Supabase
// ---------------------------------------------------------------------------

async function refreshConfig(): Promise<void> {
  try {
    const cfg = await loadB5Config();
    b5Config = cfg;
    t2BlockMs = cfg.t2_block_min * 60_000;
    t3BlockMs = cfg.t3_block_min * 60_000;
    earlyGuardSpreadPct = cfg.early_guard_spread_pct;
    earlyGuardCooldownMs = cfg.early_guard_cooldown_min * 60_000;
    console.log(`[B5] config refreshed — early_guard_spread_pct=${earlyGuardSpreadPct}%`);
  } catch (e) {
    console.warn('[B5] config refresh failed:', e instanceof Error ? e.message : e);
  }
}

// ---------------------------------------------------------------------------
// Place limit order
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
      // CLOB minimum for many 5m markets is 0.01; Gamma may return 0.001 — use at least 0.01 to avoid "invalid tick size"
      const rawTick = market.orderPriceMinTickSize != null ? Number(market.orderPriceMinTickSize) : 0.01;
      const tickSize: CreateOrderOptions['tickSize'] =
        (rawTick >= 0.01 ? String(rawTick) : '0.01') as CreateOrderOptions['tickSize'];
      const tickDecimals = String(tickSize).split('.')[1]?.length ?? 2;
      const factor = 10 ** tickDecimals;
      const price = Math.round(limitPrice * factor) / factor;
      const minSharesForNotional = Math.ceil(1 / price);
      const shares = Math.max(minSharesForNotional, Math.floor(size / price));

      console.log(`[B5] LIMIT BUY ${side} price=${price} size=${shares} ($${size}) | ${slug}`);

      const result = await client.createAndPostOrder(
        { tokenID: tokenId, price, size: shares, side: Side.BUY },
        { tickSize, negRisk: market.negRisk ?? false },
        OrderType.GTC,
      );

      const orderId = (result as { orderID?: string; orderId?: string })?.orderID
        ?? (result as { orderId?: string })?.orderId;
      if (!orderId) return { error: `No orderId in response: ${JSON.stringify(result)}` };

      const verifyOnBook = async (): Promise<boolean> => {
        try {
          const onBook = await client.getOrder(orderId);
          return onBook != null;
        } catch {
          return false;
        }
      };
      await new Promise((r) => setTimeout(r, 400));
      let onBook = await verifyOnBook();
      if (!onBook) {
        await new Promise((r) => setTimeout(r, 600));
        onBook = await verifyOnBook();
      }
      if (!onBook) {
        console.error(`[B5] place returned orderId ${orderId.slice(0, 12)}… but getOrder did not find order on book`);
        return { error: 'Place returned orderId but getOrder could not confirm order on book' };
      }
      return { orderId, tokenId, negRisk: market.negRisk ?? false, tickSize };
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function cleanupOldOrders(): void {
  const stale = openOrders.filter(o => o.windowStart !== currentWindowStart);
  for (const order of stale) {
    console.log(`[B5] window ended — removing ${order.tier} ${order.asset} ${order.direction} order`);
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
  const nowMs = Date.now();

  if (windowStartMs !== currentWindowStart) {
    currentWindowStart = windowStartMs;
    placedThisWindow.clear();
    spreadSampleBuffer.clear();
    staleSpreadThisWindow.clear();
    loggedNoChainlinkThisWindow = new Map();
    feed.setWindowOpen(windowStartMs);
  }

  cleanupOldOrders();

  // Early guard: during first 100s, if any asset has |spread| >= threshold → cooldown
  if (secInWindow <= EARLY_GUARD_WINDOW_SEC && tickCount % EARLY_GUARD_CHECK_TICKS === 0) {
    for (const asset of B5_ASSETS) {
      const windowOpen = await feed.getWindowOpen(asset);
      const spot = await feed.getSpotPrice(asset);
      if (windowOpen <= 0 || spot <= 0) continue;
      const signedSpread = (spot - windowOpen) / spot * 100;
      const absSpread = Math.abs(signedSpread);
      if (absSpread >= earlyGuardSpreadPct) {
        earlyGuardCooldownUntil = Date.now() + earlyGuardCooldownMs;
        updateB5EarlyGuard(earlyGuardCooldownUntil);
        console.log(
          `[B5] EARLY GUARD: ${asset} spread ${signedSpread.toFixed(3)}% exceeds ${earlyGuardSpreadPct}% ` +
          `at ${secInWindow.toFixed(0)}s — cooldown for ${earlyGuardCooldownMs / 60_000}min`,
        );
        break;
      }
    }
  }

  if (tickCount % 10 === 0) {
    try {
      if (await isB5EmergencyOff()) {
        if (tickCount % 100 === 0) console.log('[B5] emergency off — paused');
        return;
      }
    } catch { /* ignore */ }
  }

  if (earlyGuardCooldownUntil > Date.now()) {
    if (tickCount % 20 === 0) {
      const remainMin = Math.ceil((earlyGuardCooldownUntil - Date.now()) / 60_000);
      console.log(`[B5] early-guard cooldown — ${remainMin}min remaining`);
    }
    return;
  }

  await pollWalletBalance();

  if (Date.now() - lastConfigRefreshMs > CONFIG_CACHE_MS) {
    await refreshConfig();
    lastConfigRefreshMs = Date.now();
  }

  // Per-asset: spread, stale check, tier loop (collect spreads for periodic log like B4)
  const spreadStatus: { asset: B5Asset; signedSpread: number; spotPrice: number; spreadDir: 'up' | 'down' }[] = [];
  for (const asset of B5_ASSETS) {
    const windowOpenPrice = await feed.getWindowOpen(asset);
    const spotPrice = await feed.getSpotPrice(asset);
    if (spotPrice <= 0) continue;
    if (windowOpenPrice <= 0) {
      if (!loggedNoChainlinkThisWindow.get(asset)) {
        loggedNoChainlinkThisWindow.set(asset, true);
        try {
          await logError(
            new Error(`No Chainlink price for ${asset} — B5 skipping (retry up to 2 min, then reset).`),
            { bot: 'B5', stage: 'chainlink', asset, windowStartMs },
          );
        } catch { /* best effort */ }
      }
      continue;
    }

    const signedSpread = (spotPrice - windowOpenPrice) / spotPrice * 100;
    const absSpread = Math.abs(signedSpread);
    const spreadDir: 'up' | 'down' = spotPrice > windowOpenPrice ? 'up' : 'down';
    spreadStatus.push({ asset, signedSpread, spotPrice, spreadDir });
    const slug = getPolySlug5m(asset, now);

    let buf = spreadSampleBuffer.get(asset) ?? [];
    buf.push(signedSpread);
    if (buf.length > SPREAD_SAMPLE_SIZE) buf = buf.slice(-SPREAD_SAMPLE_SIZE);
    spreadSampleBuffer.set(asset, buf);
    if (tickCount % 10 === 0 && buf.length >= SPREAD_SAMPLE_SIZE) {
      const first = buf[0];
      if (buf.every(s => s === first)) {
        staleSpreadThisWindow.set(asset, true);
        console.log(`[B5] STALE SPREAD ${asset}: ${SPREAD_SAMPLE_SIZE} identical readings — skipping rest of window`);
      }
    }
    if (staleSpreadThisWindow.get(asset)) continue;

    const activeTiers = getTiersForAsset(b5Config, asset);
    const positionSize = b5Config.position_size;

    for (let i = activeTiers.length - 1; i >= 0; i--) {
      const tier = activeTiers[i];
      const tierKey = `${tier.name}-${windowStartMs}-${asset}`;
      if (placedThisWindow.has(tierKey)) continue;
      if (secInWindow < tier.entryAfterSec) continue;
      if (tier.name === 'B5-T3' && secInWindow >= T3_WINDOW_END_SEC) continue;
      if (absSpread < tier.spreadPct) continue;
      if (openOrders.some(o => o.tier === tier.name && o.windowStart === windowStartMs && o.asset === asset)) continue;
      if (tier.name === 'B5-T1' && nowMs < t1BlockedUntil[asset]) continue;
      if (tier.name === 'B5-T2' && nowMs < t2BlockedUntil[asset]) continue;

      const side: 'yes' | 'no' = spreadDir === 'up' ? 'yes' : 'no';
      console.log(
        `[B5] SIGNAL ${tier.name} ${asset}: spread=${absSpread.toFixed(4)}% (threshold ${tier.spreadPct}%) ` +
        `| dir=${spreadDir} | limit=${tier.limitPrice} | ${secInWindow.toFixed(0)}s into window`,
      );

      const result = await placeLimitOrder(slug, side, tier.limitPrice, positionSize);

      if (result.orderId && result.tokenId) {
        placedThisWindow.add(tierKey);
        openOrders.push({
          tier: tier.name,
          asset,
          direction: spreadDir,
          side,
          tokenId: result.tokenId,
          orderId: result.orderId,
          limitPrice: tier.limitPrice,
          size: positionSize,
          slug,
          windowStart: windowStartMs,
          spreadAtEntry: absSpread,
          signedSpread,
          priceAtEntry: spotPrice,
          windowOpenPrice,
          negRisk: result.negRisk ?? false,
          tickSize: result.tickSize ?? '0.01',
        });
        console.log(
          `[B5] PLACED ${tier.name} ${asset}: ${spreadDir} at ${tier.limitPrice} | spread=${signedSpread.toFixed(4)}% | orderId=${result.orderId.slice(0, 12)}…`,
        );
        try {
          await logPosition({
            bot: 'B5',
            asset,
            venue: 'polymarket',
            strike_spread_pct: signedSpread,
            position_size: positionSize,
            ticker_or_slug: slug,
            order_id: result.orderId,
            raw: {
              strategy: 'spread',
              tier: tier.name,
              direction: spreadDir,
              limitPrice: tier.limitPrice,
              spotPrice,
              windowOpenPrice,
              price_source: 'chainlink',
            },
          });
        } catch { /* best effort */ }

        if (tier.name === 'B5-T2') {
          t1BlockedUntil[asset] = Math.max(t1BlockedUntil[asset], nowMs + t2BlockMs);
          updateB5TierBlocks(asset, t1BlockedUntil[asset], t2BlockedUntil[asset]);
          console.log(`[B5] T2 placed ${asset} orderId=${result.orderId.slice(0, 14)}… spread=${signedSpread.toFixed(4)}% → T1 blocked for ${asset} for ${t2BlockMs / 60_000} min`);
        }
        if (tier.name === 'B5-T3') {
          t1BlockedUntil[asset] = Math.max(t1BlockedUntil[asset], nowMs + t3BlockMs);
          t2BlockedUntil[asset] = Math.max(t2BlockedUntil[asset], nowMs + t3BlockMs);
          updateB5TierBlocks(asset, t1BlockedUntil[asset], t2BlockedUntil[asset]);
          console.log(`[B5] T3 placed ${asset} orderId=${result.orderId.slice(0, 14)}… spread=${signedSpread.toFixed(4)}% → T1+T2 blocked for ${asset} for ${t3BlockMs / 60_000} min`);
        }
      } else {
        console.log(`[B5] ${tier.name} ${asset} order failed: ${result.error}`);
        try {
          await logError(new Error(result.error ?? 'order failed'), { bot: 'B5', tier: tier.name, asset, slug, side });
        } catch { /* ignore */ }
        // T3 attempted but failed (e.g. insufficient balance) → still block T1+T2 for the usual duration
        if (tier.name === 'B5-T3') {
          t1BlockedUntil[asset] = Math.max(t1BlockedUntil[asset], nowMs + t3BlockMs);
          t2BlockedUntil[asset] = Math.max(t2BlockedUntil[asset], nowMs + t3BlockMs);
          updateB5TierBlocks(asset, t1BlockedUntil[asset], t2BlockedUntil[asset]);
          console.log(`[B5] T3 attempt failed ${asset} → T1+T2 blocked for ${asset} for ${t3BlockMs / 60_000} min anyway`);
        }
      }
    }
  }

  // Periodic spread % log (like B4): strike percentages and seconds left
  if (tickCount % 3 === 0 && spreadStatus.length > 0) {
    const secLeft = Math.round(300 - secInWindow);
    const parts = spreadStatus.map((s) => `${s.asset} ${s.signedSpread.toFixed(4)}%`).join(' | ');
    console.log(`[B5] ${parts} | ${secLeft}s left`);
  }

  if (tickCount % 100 === 0) {
    console.log('');
    console.log(`[B5] ═══ Status @ ${new Date().toISOString()} ═══`);
    if (spreadStatus.length > 0) {
      const priceSpreadLine = spreadStatus
        .map((s) => `${s.asset}=$${s.spotPrice.toFixed(2)} ${s.signedSpread.toFixed(4)}% ${s.spreadDir}`)
        .join(' | ');
      console.log(`[B5] ${priceSpreadLine}`);
    }
    console.log(`[B5] Pending orders: ${openOrders.length}`);
    for (const a of B5_ASSETS) {
      if (t1BlockedUntil[a] > nowMs) console.log(`[B5] T1 blocked ${a} for ${Math.ceil((t1BlockedUntil[a] - nowMs) / 1000)}s`);
      if (t2BlockedUntil[a] > nowMs) console.log(`[B5] T2 blocked ${a} for ${Math.ceil((t2BlockedUntil[a] - nowMs) / 1000)}s`);
    }
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function startSpreadRunner(): Promise<void> {
  console.log('');
  console.log('[B5] ═══ Spread Runner Starting (ETH/SOL/XRP 5m) ═══');

  await refreshConfig();
  const blocks = await getB5Blocks();
  if (blocks) {
    const now = Date.now();
    let anyBlock = false;
    for (const a of B5_ASSETS) {
      const pa = blocks.perAsset[a];
      t1BlockedUntil[a] = (pa.t1BlockedUntilMs > now) ? pa.t1BlockedUntilMs : 0;
      t2BlockedUntil[a] = (pa.t2BlockedUntilMs > now) ? pa.t2BlockedUntilMs : 0;
      if (t1BlockedUntil[a] > 0 || t2BlockedUntil[a] > 0) anyBlock = true;
    }
    earlyGuardCooldownUntil = (blocks.earlyGuardCooldownUntilMs > now) ? blocks.earlyGuardCooldownUntilMs : 0;
    if (anyBlock || earlyGuardCooldownUntil > 0) {
      const parts: string[] = [];
      for (const a of B5_ASSETS) {
        if (t1BlockedUntil[a] > 0 || t2BlockedUntil[a] > 0) {
          parts.push(`${a}: T1 until ${t1BlockedUntil[a] ? new Date(t1BlockedUntil[a]).toISOString() : '—'}, T2 until ${t2BlockedUntil[a] ? new Date(t2BlockedUntil[a]).toISOString() : '—'}`);
        }
      }
      if (parts.length) console.log(`[B5] Blocks restored from Supabase (per-asset, set by a previous run when T2/T3 placed) — ${parts.join('; ')}`);
      if (earlyGuardCooldownUntil > 0) console.log(`[B5] Early-guard cooldown until ${new Date(earlyGuardCooldownUntil).toISOString()}`);
    }
  }

  console.log(`[B5] Position size: $${b5Config.position_size}`);
  for (const asset of B5_ASSETS) {
    const tiers = getTiersForAsset(b5Config, asset);
    console.log(`[B5] ${asset}: T1>${tiers[0].spreadPct}% T2>${tiers[1].spreadPct}% T3>${tiers[2].spreadPct}%`);
  }
  console.log(`[B5] Blocking: T2→T1 ${t2BlockMs / 60_000}min | T3→T1+T2 ${t3BlockMs / 60_000}min`);
  console.log(`[B5] Early guard: spread>${earlyGuardSpreadPct}% in first ${EARLY_GUARD_WINDOW_SEC}s → ${earlyGuardCooldownMs / 60_000}min cooldown`);
  console.log('');

  const feed = new PriceFeed();
  await new Promise((r) => setTimeout(r, 5_000));
  let anyLive = false;
  for (const asset of B5_ASSETS) {
    if (feed.isChainlinkLive(asset)) {
      const cl = getChainlinkPrice(asset);
      if (cl) console.log(`[B5] Chainlink ${asset}=$${cl.price.toFixed(4)}`);
      anyLive = true;
    }
  }
  if (!anyLive) console.warn('[B5] Chainlink not connected yet — will keep trying');

  let tickCount = 0;
  const runTick = async () => {
    const tickStartMs = Date.now();
    tickCount++;
    try {
      await runOneTick(feed, tickCount);
    } catch (e) {
      console.error('[B5] tick error:', e instanceof Error ? e.message : e);
      try { await logError(e instanceof Error ? e : new Error(String(e)), { bot: 'B5', stage: 'tick' }); } catch { /* ignore */ }
    }
    const elapsedMs = Date.now() - tickStartMs;
    const delayMs = Math.max(0, MIN_TICK_DELAY_MS - elapsedMs);
    setTimeout(runTick, delayMs);
  };
  runTick();

  const shutdown = () => {
    console.log(`[B5] shutting down — ${openOrders.length} pending orders will resolve on-chain`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
