/**
 * B4 Spread Runner — Live 5-Minute BTC Spread Strategy
 *
 * Adapted from B1/B2/B3 (15-min Kalshi) for Polymarket 5-minute markets.
 * Uses spread between current Chainlink BTC price and window open price.
 *
 * Three tiers (configurable from dashboard via b4_state.results_json):
 *
 *   B4-T1: spread > 0.10%, entry in last 50s (after 250s), limit 96c
 *   B4-T2: spread > 0.21%, entry in last 100s (after 200s), limit 97c
 *          → BLOCKS T1 for 5 minutes after entry
 *   B4-T3: spread > 0.45%, entry in last 160s (after 140s), limit 97c
 *          → BLOCKS T1 AND T2 for 15 minutes after entry
 *
 * Positions resolve at window end (no early exit). Hold until $1 or $0.
 * Orders placed via Polymarket CLOB (GTC limit orders).
 */

import 'dotenv/config';
import { ethers } from 'ethers';
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
  loadB4Config,
  getDb,
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
// Configuration (defaults — overridden by Supabase b4_state.results_json)
// ---------------------------------------------------------------------------

interface TierConfig {
  name: string;
  spreadPct: number;
  entryAfterSec: number;
  limitPrice: number;
}

let activeTiers: TierConfig[] = [
  { name: 'B4-T1', spreadPct: 0.10, entryAfterSec: 250, limitPrice: 0.96 },
  { name: 'B4-T2', spreadPct: 0.21, entryAfterSec: 180, limitPrice: 0.97 },
  { name: 'B4-T3', spreadPct: 0.45, entryAfterSec: 100, limitPrice: 0.97 },
];

let positionSize = parseFloat(process.env.B4_POSITION_SIZE || '5');
const TICK_INTERVAL_MS = 3_000;

// Blocking durations (configurable)
let t2BlockMs = 5 * 60_000;   // T2 → blocks T1 for 5 min
let t3BlockMs = 15 * 60_000;  // T3 → blocks T1 + T2 for 15 min

// Early-window high-spread guard: check every 15s during first 100s,
// if spread > threshold → cooldown on B4 spread bot only
const EARLY_GUARD_WINDOW_SEC = 100;
const EARLY_GUARD_CHECK_TICKS = 5;           // every 5 ticks = 15s at 3s/tick
let earlyGuardSpreadPct = 0.6;               // configurable from dashboard
let earlyGuardCooldownMs = 60 * 60_000;      // configurable from dashboard

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
  signedSpread: number;
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

// Blocking timestamps
let t1BlockedUntil = 0;
let t2BlockedUntil = 0;

// Early-guard cooldown (in-memory only — does NOT affect B1c/B2c/B3c)
let earlyGuardCooldownUntil = 0;

// ---------------------------------------------------------------------------
// Wallet balance polling (every ~15 min → updates b4_state.bankroll)
// ---------------------------------------------------------------------------

const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const WALLET_ADDRESS = process.env.POLYMARKET_PROXY_WALLET?.trim()
  ?? process.env.POLYMARKET_FUNDER?.trim()
  ?? process.env.POLYGUN_CLAIM_SAFE_ADDRESS?.trim()
  ?? '0x25695dB083FeF07d6C1CA0f5E0cbbff915C5613D';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
const BALANCE_POLL_MS = 15 * 60_000; // 15 minutes
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
    console.log(`[B4] wallet balance: $${balance.toFixed(2)}`);
    await getDb().from('b4_state').update({
      bankroll: balance,
      max_bankroll: balance,
      updated_at: new Date().toISOString(),
    }).eq('id', 'default');
  } catch (e) {
    console.warn('[B4] balance poll failed:', e instanceof Error ? e.message : e);
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
  const cfg = getPolyClobConfigFromEnv();
  return cfg != null ? createPolyClobClient(cfg) : await getOrCreateDerivedPolyClient();
}

// ---------------------------------------------------------------------------
// Refresh config from Supabase
// ---------------------------------------------------------------------------

async function refreshConfig(): Promise<void> {
  try {
    const cfg = await loadB4Config();
    activeTiers = [
      { name: 'B4-T1', spreadPct: cfg.t1_spread, entryAfterSec: 250, limitPrice: 0.96 },
      { name: 'B4-T2', spreadPct: cfg.t2_spread, entryAfterSec: 180, limitPrice: 0.97 },
      { name: 'B4-T3', spreadPct: cfg.t3_spread, entryAfterSec: 100, limitPrice: 0.97 },
    ];
    positionSize = cfg.position_size;
    t2BlockMs = cfg.t2_block_min * 60_000;
    t3BlockMs = cfg.t3_block_min * 60_000;
    earlyGuardSpreadPct = cfg.early_guard_spread_pct;
    earlyGuardCooldownMs = cfg.early_guard_cooldown_min * 60_000;
  } catch (e) {
    console.warn('[B4] config refresh failed, using current values:', e instanceof Error ? e.message : e);
  }
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
        `[B4] LIMIT BUY ${side} price=${price} size=${shares} ($${size}) | ${slug}`,
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
// Clean up stale orders from previous windows (no bankroll tracking —
// limit orders may not fill, so we can't assume P&L from placement alone)
// ---------------------------------------------------------------------------

function cleanupOldOrders(): void {
  const stale = openOrders.filter(o => o.windowStart !== currentWindowStart);
  for (const order of stale) {
    console.log(`[B4] window ended — removing ${order.tier} ${order.direction} order (fill unknown)`);
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

  // Clean up orders from previous windows
  cleanupOldOrders();

  // B4 emergency off check (manual pause from dashboard)
  if (tickCount % 10 === 0) {
    try {
      if (await isB4EmergencyOff()) {
        if (tickCount % 100 === 0) console.log('[B4] emergency off — paused');
        return;
      }
    } catch { /* Supabase may not be configured */ }
  }

  // Early-guard cooldown check (in-memory, B4 only)
  if (earlyGuardCooldownUntil > Date.now()) {
    if (tickCount % 20 === 0) {
      const remainMin = Math.ceil((earlyGuardCooldownUntil - Date.now()) / 60_000);
      console.log(`[B4] early-guard cooldown active — ${remainMin}min remaining`);
    }
    return;
  }

  // Poll wallet balance every ~15 min
  await pollWalletBalance();

  // Refresh config from Supabase every ~30 ticks (~90 seconds)
  if (tickCount % 30 === 0) {
    await refreshConfig();
  }

  // Calculate spread
  const windowOpenPrice = await feed.getWindowOpen();
  if (windowOpenPrice <= 0) return;

  const signedSpread = (btcPrice - windowOpenPrice) / btcPrice * 100;
  const absSpread = Math.abs(signedSpread);
  const spreadDir: 'up' | 'down' = btcPrice > windowOpenPrice ? 'up' : 'down';
  const slug = getPolySlug5m(now);
  const nowMs = Date.now();

  // --- Early-window high-spread guard (B4 only, in-memory) ---
  // During first 100s, check every ~15s: if spread > threshold → cooldown on B4 spread bot
  if (secInWindow <= EARLY_GUARD_WINDOW_SEC && tickCount % EARLY_GUARD_CHECK_TICKS === 0) {
    if (absSpread >= earlyGuardSpreadPct) {
      earlyGuardCooldownUntil = Date.now() + earlyGuardCooldownMs;
      const cooldownMin = Math.round(earlyGuardCooldownMs / 60_000);
      console.log(
        `[B4] EARLY GUARD: spread ${signedSpread.toFixed(3)}% exceeds ${earlyGuardSpreadPct}% ` +
        `at ${secInWindow.toFixed(0)}s — B4 cooldown for ${cooldownMin}min (until ${new Date(earlyGuardCooldownUntil).toISOString()})`,
      );
      return;
    }
  }

  // Check tiers from HIGHEST to LOWEST (T3 first → T2 → T1)
  // This ensures higher tier blocks take effect before lower tiers are checked
  for (let i = activeTiers.length - 1; i >= 0; i--) {
    const tier = activeTiers[i];
    const tierKey = `${tier.name}-${windowStartMs}`;

    // Already placed this tier this window
    if (placedThisWindow.has(tierKey)) continue;

    // Time check: must be past entryAfterSec
    if (secInWindow < tier.entryAfterSec) continue;

    // Spread check
    if (absSpread < tier.spreadPct) continue;

    // Already have this tier open for this window
    if (openOrders.some(o => o.tier === tier.name && o.windowStart === windowStartMs)) continue;

    // Blocking check
    if (tier.name === 'B4-T1' && nowMs < t1BlockedUntil) {
      if (tickCount % 20 === 0) {
        const remainSec = Math.ceil((t1BlockedUntil - nowMs) / 1000);
        console.log(`[B4] T1 blocked for ${remainSec}s more`);
      }
      continue;
    }
    if (tier.name === 'B4-T2' && nowMs < t2BlockedUntil) {
      if (tickCount % 20 === 0) {
        const remainSec = Math.ceil((t2BlockedUntil - nowMs) / 1000);
        console.log(`[B4] T2 blocked for ${remainSec}s more`);
      }
      continue;
    }

    const side: 'yes' | 'no' = spreadDir === 'up' ? 'yes' : 'no';

    console.log(
      `[B4] SIGNAL ${tier.name}: spread=${absSpread.toFixed(4)}% (threshold ${tier.spreadPct}%) ` +
      `| dir=${spreadDir} | limit=${tier.limitPrice} | ${secInWindow.toFixed(0)}s into window`,
    );

    const result = await placeLimitOrder(slug, side, tier.limitPrice, positionSize);

    if (result.orderId && result.tokenId) {
      placedThisWindow.add(tierKey);
      openOrders.push({
        tier: tier.name,
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
        btcPriceAtEntry: btcPrice,
        windowOpenPrice,
        negRisk: result.negRisk ?? false,
        tickSize: result.tickSize ?? '0.01',
      });

      console.log(
        `[B4] PLACED ${tier.name}: ${spreadDir} at ${tier.limitPrice} ` +
        `| orderId=${result.orderId.slice(0, 12)}… ` +
        `| spread=${signedSpread.toFixed(4)}%`,
      );

      // Log entry to Supabase positions table (for dashboard)
      try {
        await logPosition({
          bot: 'B4',
          asset: 'BTC',
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
            btcPrice,
            windowOpenPrice,
            price_source: 'chainlink',
          },
        });
      } catch { /* best effort */ }

      // Apply blocking rules
      if (tier.name === 'B4-T2') {
        t1BlockedUntil = Math.max(t1BlockedUntil, nowMs + t2BlockMs);
        console.log(`[B4] T2 entered → T1 blocked for ${t2BlockMs / 60_000} min (until ${new Date(t1BlockedUntil).toISOString()})`);
      }
      if (tier.name === 'B4-T3') {
        t1BlockedUntil = Math.max(t1BlockedUntil, nowMs + t3BlockMs);
        t2BlockedUntil = Math.max(t2BlockedUntil, nowMs + t3BlockMs);
        console.log(`[B4] T3 entered → T1+T2 blocked for ${t3BlockMs / 60_000} min (until ${new Date(t1BlockedUntil).toISOString()})`);
      }
    } else {
      console.log(`[B4] ${tier.name} order failed: ${result.error}`);
      try {
        await logError(new Error(result.error ?? 'order failed'), { bot: 'B4', tier: tier.name, slug, side });
      } catch { /* ignore */ }
    }
  }

  // Periodic status log (~every 9 seconds)
  if (tickCount % 3 === 0 && absSpread > 0.001) {
    const secLeft = Math.round(300 - secInWindow);
    console.log(`[B4] ${signedSpread.toFixed(4)}% | ${secLeft}s left`);
  }

  if (tickCount % 100 === 0) {
    console.log('');
    console.log(`[B4] ═══ Status @ ${new Date().toISOString()} ═══`);
    console.log(`[B4] BTC=$${btcPrice.toFixed(2)} | spread=${signedSpread.toFixed(4)}% ${spreadDir}`);
    console.log(`[B4] Tiers: T1>${activeTiers[0].spreadPct}% T2>${activeTiers[1].spreadPct}% T3>${activeTiers[2].spreadPct}%`);
    console.log(`[B4] Pending orders: ${openOrders.length}`);
    if (t1BlockedUntil > nowMs) console.log(`[B4] T1 blocked for ${Math.ceil((t1BlockedUntil - nowMs) / 1000)}s`);
    if (t2BlockedUntil > nowMs) console.log(`[B4] T2 blocked for ${Math.ceil((t2BlockedUntil - nowMs) / 1000)}s`);
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function startSpreadRunner(): Promise<void> {
  console.log('');
  console.log('[B4] ═══ Spread Runner Starting ═══');

  // Load config from Supabase
  await refreshConfig();

  console.log(`[B4] Position size: $${positionSize}`);
  console.log('[B4] Tiers:');
  for (const t of activeTiers) {
    console.log(`[B4]   ${t.name}: spread>${t.spreadPct}%, entry after ${t.entryAfterSec}s, limit ${t.limitPrice}`);
  }
  console.log(`[B4] Blocking: T2→T1 for ${t2BlockMs / 60_000}min | T3→T1+T2 for ${t3BlockMs / 60_000}min`);
  console.log(`[B4] Early guard: spread>${earlyGuardSpreadPct}% in first ${EARLY_GUARD_WINDOW_SEC}s → ${earlyGuardCooldownMs / 60_000}min cooldown`);
  console.log('[B4] Strategy: buy at limit, hold to window resolution ($1 or $0)');
  console.log('');

  const feed = new PriceFeed();

  // Wait for Chainlink
  await new Promise((r) => setTimeout(r, 5_000));
  if (feed.isChainlinkLive()) {
    const cl = getChainlinkPrice();
    console.log(`[B4] Chainlink LIVE — BTC=$${cl?.price.toFixed(2) ?? '?'}`);
  } else {
    console.warn('[B4] Chainlink not connected yet — will keep trying');
  }

  let tickCount = 0;

  const runTick = async () => {
    tickCount++;
    try {
      await feed.refresh();
      await runOneTick(feed, tickCount);
    } catch (e) {
      console.error('[B4] tick error:', e instanceof Error ? e.message : e);
      try { await logError(e, { bot: 'B4', stage: 'tick' }); } catch { /* ignore */ }
    }
    setTimeout(runTick, TICK_INTERVAL_MS);
  };

  runTick();

  const shutdown = () => {
    console.log('');
    console.log(`[B4] shutting down — ${openOrders.length} pending orders will resolve on-chain`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
