/**
 * B1c/B2c/B3c — Chainlink-only clone of B1/B2/B3 for 15-minute Polymarket markets.
 *
 * Runs on the B4 droplet with the B4 wallet. Same spread thresholds, timing
 * windows, and blocking rules as the original B1/B2/B3, but:
 *   1. Chainlink RTDS only; no Binance fallback (same as B4 — if stale, skip)
 *   2. Polymarket only (no Kalshi)
 *   3. Separate position sizing
 *   4. All blocking in-memory (does NOT touch asset_blocks table)
 *   5. Uses B4 pause button (isB4EmergencyOff)
 *
 * Bot IDs: B1c, B2c, B3c — completely isolated from B1/B2/B3.
 */

import 'dotenv/config';
import WebSocket from 'ws';
import {
  minutesLeftInWindow,
  isB1Window,
  isB2Window,
  isB3Window,
  isB1LimitOrderWindow,
  isB1MarketOrderWindow,
  getCurrentPolySlug,
  isBlackoutWindow,
} from '../clock.js';
import {
  logError,
  logPosition,
  getB123cDashboardConfig,
  getPositionsInWindowB123c,
  type BotId,
  type Asset,
} from '../db/supabase.js';
import { isOutsideSpreadThreshold, type SpreadThresholdsMatrix } from '../kalshi/spread.js';
import { getOrCreateDerivedPolyClient } from '../polymarket/clob.js';
import { getPolyMarketBySlug } from '../polymarket/gamma.js';
import {
  Side,
  OrderType,
  AssetType,
  type ClobClient,
  type CreateOrderOptions,
} from '@polymarket/clob-client';

// ---------------------------------------------------------------------------
// Chainlink RTDS — multi-asset price feed
// ---------------------------------------------------------------------------

const RTDS_URL = 'wss://ws-live-data.polymarket.com';
const PING_MS = 5_000;
const RECONNECT_MS = 3_000;
const ASSETS: Asset[] = ['BTC', 'ETH', 'SOL', 'XRP'];

const SYMBOL_MAP: Record<string, Asset> = {
  'btc/usd': 'BTC', 'eth/usd': 'ETH', 'sol/usd': 'SOL', 'xrp/usd': 'XRP',
};

const chainlinkPrices: Record<Asset, { price: number; ts: number }> = {
  BTC: { price: 0, ts: 0 }, ETH: { price: 0, ts: 0 },
  SOL: { price: 0, ts: 0 }, XRP: { price: 0, ts: 0 },
};

let rtdsWs: WebSocket | null = null;
let rtdsPing: ReturnType<typeof setInterval> | null = null;
let rtdsStaleCheck: ReturnType<typeof setInterval> | null = null;
let rtdsReconnecting = false;
/** Last time we received any price update from RTDS (any asset). Used to detect silent connection. */
let rtdsLastMessageMs = 0;

/** If no price message received for this long, force reconnect (connection may be open but silent). */
const RTDS_SILENT_RECONNECT_MS = 45_000;

function connectRTDS(): void {
  if (rtdsWs && (rtdsWs.readyState === WebSocket.OPEN || rtdsWs.readyState === WebSocket.CONNECTING)) return;
  rtdsReconnecting = false;
  try { rtdsWs = new WebSocket(RTDS_URL); } catch { scheduleReconnect(); return; }

  rtdsWs.on('open', () => {
    console.log('[B123c] RTDS connected');
    rtdsLastMessageMs = Date.now();
    rtdsWs!.send(JSON.stringify({
      action: 'subscribe',
      subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*' }],
    }));
    if (rtdsPing) clearInterval(rtdsPing);
    rtdsPing = setInterval(() => {
      if (rtdsWs?.readyState === WebSocket.OPEN) rtdsWs.send(JSON.stringify({ action: 'ping' }));
    }, PING_MS);
    if (rtdsStaleCheck) clearInterval(rtdsStaleCheck);
    rtdsStaleCheck = setInterval(() => {
      if (rtdsWs?.readyState !== WebSocket.OPEN || rtdsReconnecting) return;
      const elapsed = Date.now() - rtdsLastMessageMs;
      if (elapsed > RTDS_SILENT_RECONNECT_MS) {
        console.warn(`[B123c] RTDS silent ${Math.round(elapsed / 1000)}s – reconnecting`);
        try { rtdsWs.close(); } catch {}
      }
    }, 10_000);
  });

  rtdsWs.on('message', (raw: WebSocket.Data) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        topic?: string; payload?: { symbol?: string; value?: number; timestamp?: number };
      };
      if (msg.topic === 'crypto_prices_chainlink' && msg.payload?.symbol && msg.payload.value) {
        rtdsLastMessageMs = Date.now();
        const asset = SYMBOL_MAP[msg.payload.symbol];
        if (asset) chainlinkPrices[asset] = { price: msg.payload.value, ts: msg.payload.timestamp ?? Date.now() };
      }
    } catch { /* ignore */ }
  });

  rtdsWs.on('close', () => { console.warn('[B123c] RTDS disconnected'); scheduleReconnect(); });
  rtdsWs.on('error', (e: Error) => { console.error('[B123c] RTDS error:', e.message); try { rtdsWs?.close(); } catch {} scheduleReconnect(); });
}

function scheduleReconnect(): void {
  if (rtdsReconnecting) return;
  rtdsReconnecting = true;
  if (rtdsPing) { clearInterval(rtdsPing); rtdsPing = null; }
  if (rtdsStaleCheck) { clearInterval(rtdsStaleCheck); rtdsStaleCheck = null; }
  rtdsWs = null;
  setTimeout(connectRTDS, RECONNECT_MS);
}

/** Max age (ms) for Chainlink price before considered stale. No Binance fallback. */
const PRICE_STALE_MS = 60_000;
/** No Chainlink for this long → soft reset (clear window open, log to website), same as B4. */
const CHAINLINK_RETRY_MS = 2 * 60_000;

function getPrice(asset: Asset): number | null {
  const p = chainlinkPrices[asset];
  if (p.price <= 0 || Date.now() - p.ts > PRICE_STALE_MS) return null;
  return p.price;
}

/** Current price — Chainlink only (no Binance). If stale, returns null and we skip that asset. */
async function getPriceOrFallback(asset: Asset): Promise<number | null> {
  return getPrice(asset);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MIN_TICK_DELAY_MS = 1_000;
const DASHBOARD_CACHE_MS = 15 * 60 * 1000;
type DashboardCache = Awaited<ReturnType<typeof getB123cDashboardConfig>> & { ts: number };
let dashboardCache: DashboardCache | null = null;
const CLOB_REFRESH_MS = 15 * 60 * 1000;
let lastClobRefreshMs = 0;

// ---------------------------------------------------------------------------
// State — 15-minute window tracking
// ---------------------------------------------------------------------------

const WINDOW_MS = 15 * 60 * 1000;

function getWindowEndMs(now: Date = new Date()): number {
  const ms = now.getTime();
  return ms - (ms % WINDOW_MS) + WINDOW_MS;
}

let currentWindowEndMs = 0;
const windowOpenPrices: Record<Asset, number> = { BTC: 0, ETH: 0, SOL: 0, XRP: 0 };
/** First time we had no price this window; after 2 min we soft-reset and log (same as B4). */
let noPriceSinceMs = 0;
let didSoftResetThisWindow = false;
const enteredThisWindow = new Set<string>();

function windowKey(bot: string, asset: Asset, windowEnd: number): string {
  return `${windowEnd}-${bot}-${asset}`;
}

// ---------------------------------------------------------------------------
// In-memory blocking (completely separate from B1/B2/B3 asset_blocks table)
// ---------------------------------------------------------------------------

const b3cBlockUntil = new Map<Asset, number>();       // B3c placed → block B1c/B2c
const b2cHighSpreadAt = new Map<Asset, number>();      // B2c saw high spread → block B1c
const b3cEarlyHighAt = new Map<Asset, number>();       // B3c early high spread → block B3c

/** When CLOB returns "not enough balance / allowance", stop placing for this long to avoid log spam. */
const BALANCE_ERROR_BACKOFF_MS = 5 * 60 * 1000;
let balanceErrorBackoffUntil = 0;

function isB1cBlocked(asset: Asset, now: number, b2BlockMs: number): boolean {
  const b3t = b3cBlockUntil.get(asset);
  if (b3t && now < b3t) return true;
  const b2t = b2cHighSpreadAt.get(asset);
  if (b2t && now - b2t < b2BlockMs) return true;
  return false;
}

function isB2cBlocked(asset: Asset, now: number): boolean {
  const b3t = b3cBlockUntil.get(asset);
  return !!(b3t && now < b3t);
}

/** Return block reason for B1c for logging, or null if not blocked. */
function b1cBlockReason(asset: Asset, now: number, b2BlockMs: number, b2BlockMin: number): string | null {
  const b3t = b3cBlockUntil.get(asset);
  if (b3t && now < b3t) return `B3c cooldown (${Math.ceil((b3t - now) / 60_000)} min left)`;
  const b2t = b2cHighSpreadAt.get(asset);
  if (b2t && now - b2t < b2BlockMs) return `${b2BlockMin} min delay after B2c high spread (${Math.ceil((b2BlockMs - (now - b2t)) / 60_000)} min left)`;
  return null;
}

// ---------------------------------------------------------------------------
// Proxy wrapper + CLOB client
// ---------------------------------------------------------------------------

let warnedNoProxy = false;

async function withPolyProxy<T>(fn: () => Promise<T>): Promise<T> {
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '';
  if (!proxy) {
    if (!warnedNoProxy) {
      warnedNoProxy = true;
      console.warn('[B123c] No HTTPS_PROXY or HTTP_PROXY — orders not using proxy. Add to .env.b123c or load .env in cursorbot-b123c.service');
    }
    return fn();
  }
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

/** B123c uses derive only (same as B4/D1); static API keys do not work for placement. */
async function getClobClient(): Promise<ClobClient> {
  return getOrCreateDerivedPolyClient();
}

// ---------------------------------------------------------------------------
// Place Polymarket GTC limit order. No balance check — use website order size only.
// ---------------------------------------------------------------------------

async function placeLimitOrder(
  slug: string, side: 'yes' | 'no', limitPrice: number, size: number,
): Promise<{ orderId?: string; error?: string }> {
  try {
    return await withPolyProxy(async () => {
      const market = await getPolyMarketBySlug(slug);
      if (!market) return { error: `Market not found: ${slug}` };
      const tokenId = side === 'yes' ? market.clobTokenIds[0] : market.clobTokenIds[1];
      if (!tokenId) return { error: `No ${side} token for ${slug}` };
      const client = await getClobClient();
      // CLOB minimum for many 15m markets is 0.01; Gamma may return 0.001 — use at least 0.01 to avoid "invalid tick size" (B1c/2c/3c).
      const rawTick = market.orderPriceMinTickSize != null ? Number(market.orderPriceMinTickSize) : 0.01;
      const tickSize: CreateOrderOptions['tickSize'] =
        (rawTick >= 0.01 ? String(rawTick) : '0.01') as CreateOrderOptions['tickSize'];
      const tickDec = String(tickSize).split('.')[1]?.length ?? 2;
      const factor = 10 ** tickDec;
      const price = Math.round(limitPrice * factor) / factor;
      const minShares = market.orderMinSize ?? 1;
      const shares = Math.max(minShares, Math.floor(size / price));
      console.log(`[B123c] LIMIT BUY ${side} price=${price} shares=${shares} ($${size}) | ${slug}`);
      const result = await client.createAndPostOrder(
        { tokenID: tokenId, price, size: shares, side: Side.BUY },
        { tickSize, negRisk: market.negRisk ?? false },
        OrderType.GTC,
      );
      const orderId = (result as { orderID?: string; orderId?: string })?.orderID
        ?? (result as { orderId?: string })?.orderId;
      if (!orderId) return { error: `No orderId: ${JSON.stringify(result)}` };
      return { orderId };
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Place for a specific bot/tier and log result
// ---------------------------------------------------------------------------

async function tryPlace(
  bot: BotId, asset: Asset, slug: string, limitPrice: number,
  signedSpread: number, side: 'yes' | 'no', size: number,
): Promise<boolean> {
  const result = await placeLimitOrder(slug, side, limitPrice, size);
  if (result.orderId) {
    console.log(`[B123c] ${bot} ${asset} ${side} ${limitPrice * 100}c placed | orderId=${result.orderId.slice(0, 12)}… spread=${signedSpread.toFixed(3)}%`);
    try {
      await logPosition({
        bot, asset, venue: 'polymarket',
        strike_spread_pct: signedSpread,
        position_size: size,
        ticker_or_slug: slug,
        order_id: result.orderId,
        raw: { price_source: 'chainlink', limitPrice, direction: side },
      });
    } catch { /* best effort */ }
    return true;
  }
  const err = result.error ?? '';
  const isBalanceError = /not enough balance|allowance/i.test(err);
  if (isBalanceError && Date.now() > balanceErrorBackoffUntil) {
    balanceErrorBackoffUntil = Date.now() + BALANCE_ERROR_BACKOFF_MS;
    console.log(
      '[B123c] CLOB "not enough balance / allowance" — backing off 5 min. Polymarket reserves balance for resting limit orders (even unfilled); one placed order can block the next. Same wallet for all assets. Check B123c USDC and allowance (.env.b123c).',
    );
  }
  if (!isBalanceError) {
    console.log(`[B123c] ${bot} ${asset} order failed: ${err}`);
    try { await logError(new Error(err || 'order failed'), { bot, asset, slug, side }); } catch {}
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

async function runOneTick(now: Date, tickCount: number): Promise<void> {
  if (isBlackoutWindow(now)) return;

  const nowMs = now.getTime();
  if (!dashboardCache || nowMs - dashboardCache.ts > DASHBOARD_CACHE_MS) {
    try {
      const fresh = await getB123cDashboardConfig();
      dashboardCache = { ...fresh, ts: nowMs };
    } catch (e) {
      if (tickCount % 12 === 0) console.warn('[B123c] dashboard config fetch failed:', e instanceof Error ? e.message : e);
      if (!dashboardCache) return;
    }
  }
  if (dashboardCache.emergencyOff) {
    if (tickCount % 100 === 0) console.log('[B123c] paused');
    return;
  }

  if (nowMs - lastClobRefreshMs >= CLOB_REFRESH_MS) {
    lastClobRefreshMs = nowMs;
    try {
      await withPolyProxy(async () => {
        const client = await getClobClient();
        await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        console.log('[B123c] USDC balance/allowance refreshed for CLOB');
      });
    } catch (e) {
      console.warn('[B123c] CLOB balance/allowance refresh failed (non-fatal):', e instanceof Error ? e.message : e);
    }
  }

  const minLeft = minutesLeftInWindow(now);
  const windowEnd = getWindowEndMs(now);
  const windowStartMs = windowEnd - WINDOW_MS;
  const positionSize = dashboardCache.positionSize;
  const { spreadThresholds, delays } = dashboardCache;
  const b3BlockMs = delays.b3BlockMin * 60_000;
  const b2HighSpreadBlockMs = delays.b2HighSpreadBlockMin * 60_000;

  const positionsInWindow = await getPositionsInWindowB123c(windowStartMs);
  const skipPlacementBalance = nowMs < balanceErrorBackoffUntil;
  if (skipPlacementBalance && tickCount % 60 === 0) {
    console.log('[B123c] placement skipped: balance/allowance backoff (resting orders reserve balance on Polymarket) — check B123c wallet');
  }

  // New window → capture open prices (Chainlink only), clear tracking
  if (windowEnd !== currentWindowEndMs) {
    currentWindowEndMs = windowEnd;
    enteredThisWindow.clear();
    noPriceSinceMs = 0;
    didSoftResetThisWindow = false;
    for (const a of ASSETS) {
      const p = await getPriceOrFallback(a);
      if (p && p > 0) {
        windowOpenPrices[a] = p;
        if (tickCount > 1) console.log(`[B123c] window open ${a}: $${p.toFixed(2)}`);
      }
    }
  }

  // No Chainlink for 2 min → soft reset (clear window open, log to website), same as B4
  if (noPriceSinceMs > 0 && nowMs - noPriceSinceMs >= CHAINLINK_RETRY_MS && !didSoftResetThisWindow) {
    didSoftResetThisWindow = true;
    for (const a of ASSETS) windowOpenPrices[a] = 0;
    noPriceSinceMs = 0;
    console.log('[B123c] No Chainlink price for 2 min — soft reset (same as B4)');
    try {
      await logError(
        new Error('No Chainlink price — B123c skipping; soft reset after 2 min (same as B4). No orders until next window.'),
        { bot: 'B123c', stage: 'chainlink', windowEndMs: currentWindowEndMs },
      );
    } catch { /* best effort */ }
  }

  let anySkippedNoPrice = false;
  // We do NOT limit to one order per window across assets — we allow one per (bot, asset). Polymarket CLOB reserves balance for each resting limit order (maxOrderSize = balance - openOrderSize), so one placed (unfilled) order can cause "not enough balance" for the next.
  for (const asset of ASSETS) {
    const price = await getPriceOrFallback(asset);
    const openPrice = windowOpenPrices[asset];
    if (!price || !openPrice || openPrice <= 0) {
      if (!price) anySkippedNoPrice = true;
      continue;
    }

    const signedSpread = ((price - openPrice) / price) * 100;
    const abSpread = Math.abs(signedSpread);
    if (abSpread === 0) continue;
    if (abSpread > 2) { if (tickCount % 20 === 0) console.log(`[B123c] ${asset} skip: |spread| ${abSpread.toFixed(2)}% > 2% failsafe`); continue; }
    const side: 'yes' | 'no' = signedSpread >= 0 ? 'yes' : 'no';
    const slug = getCurrentPolySlug(asset, now);

    // --- B3c early guard: high spread in first 7 min → block B1c/B2c and skip B3c for this asset ---
    if (minLeft > 8 && abSpread > delays.b3EarlyHighSpreadPct) {
      b3cEarlyHighAt.set(asset, nowMs);
      b3cBlockUntil.set(asset, nowMs + b3BlockMs);
      if (tickCount % 12 === 0) {
        console.log(`[B123c] B3c ${asset} early guard: spread ${abSpread.toFixed(2)}% > ${delays.b3EarlyHighSpreadPct}% → block B1c/B2c ${delays.b3BlockMin}min, skip B3c ${delays.b3EarlyHighSpreadBlockMin}min`);
      }
    }

    // --- B1c: last 2.5 min ---
    if (isB1Window(minLeft)) {
      const b1cReason = b1cBlockReason(asset, nowMs, b2HighSpreadBlockMs, delays.b2HighSpreadBlockMin);
      if (b1cReason && tickCount % 6 === 0) {
        console.log(`[B123c] B1c ${asset} skip: ${b1cReason}`);
      }
    }
    if (isB1Window(minLeft) && !isB1cBlocked(asset, nowMs, b2HighSpreadBlockMs)) {
      const key = windowKey('B1c', asset, windowEnd);
      if (positionsInWindow.has('B1c-' + asset)) enteredThisWindow.add(key);
      if (!enteredThisWindow.has(key) && isOutsideSpreadThreshold('B1', asset, abSpread, spreadThresholds) && !skipPlacementBalance) {
        const useMarket = isB1MarketOrderWindow(minLeft);
        const priceB1 = useMarket ? 0.99 : 0.96;
        console.log(`[B123c] attempting B1c ${asset} ${side} ${(priceB1 * 100).toFixed(0)}c | spread=${signedSpread.toFixed(3)}%`);
        const placed = await tryPlace('B1c', asset, slug, priceB1, signedSpread, side, positionSize);
        if (placed) enteredThisWindow.add(key);
      }
    }

    // --- B2c: last 5 min ---
    if (isB2Window(minLeft) && isB2cBlocked(asset, nowMs) && tickCount % 6 === 0) {
      const b3t = b3cBlockUntil.get(asset);
      const blockMinLeft = b3t ? Math.ceil((b3t - nowMs) / 60_000) : 0;
      console.log(`[B123c] B2c ${asset} skip: blocked by B3c cooldown (${blockMinLeft} min left)`);
    }
    if (isB2Window(minLeft) && !isB2cBlocked(asset, nowMs)) {
      if (abSpread > delays.b2HighSpreadThresholdPct) b2cHighSpreadAt.set(asset, nowMs);
      const key = windowKey('B2c', asset, windowEnd);
      if (positionsInWindow.has('B2c-' + asset)) enteredThisWindow.add(key);
      if (!enteredThisWindow.has(key) && isOutsideSpreadThreshold('B2', asset, abSpread, spreadThresholds) && !skipPlacementBalance) {
        console.log(`[B123c] attempting B2c ${asset} ${side} 97c | spread=${signedSpread.toFixed(3)}%`);
        const placed = await tryPlace('B2c', asset, slug, 0.97, signedSpread, side, positionSize);
        if (placed) enteredThisWindow.add(key);
      }
    }

    // --- B3c: last 8 min ---
    if (isB3Window(minLeft)) {
      const earlyT = b3cEarlyHighAt.get(asset);
      const earlyBlockMs = delays.b3EarlyHighSpreadBlockMin * 60_000;
      if (earlyT && nowMs - earlyT < earlyBlockMs) {
        if (tickCount % 6 === 0) {
          const minLeft = Math.ceil((earlyBlockMs - (nowMs - earlyT)) / 60_000);
          console.log(`[B123c] B3c ${asset} skip: early guard (high spread in first 7 min) — ${minLeft} min left`);
        }
        continue;
      }

      const key = windowKey('B3c', asset, windowEnd);
      if (positionsInWindow.has('B3c-' + asset)) enteredThisWindow.add(key);
      if (!enteredThisWindow.has(key) && isOutsideSpreadThreshold('B3', asset, abSpread, spreadThresholds) && !skipPlacementBalance) {
        console.log(`[B123c] attempting B3c ${asset} ${side} 97c | spread=${signedSpread.toFixed(3)}%`);
        const placed = await tryPlace('B3c', asset, slug, 0.97, signedSpread, side, positionSize);
        if (placed) {
          enteredThisWindow.add(key);
          b3cBlockUntil.set(asset, nowMs + b3BlockMs);
          console.log(`[B123c] B3c ${asset} placed → block B1c/B2c for ${delays.b3BlockMin}min`);
        }
      }
    }
  }

  if (anySkippedNoPrice) {
    if (noPriceSinceMs === 0) noPriceSinceMs = nowMs;
    if (tickCount % 12 === 0) {
      const stale = ASSETS.filter(a => !getPrice(a));
      if (stale.length) console.log(`[B123c] no price (Chainlink stale >${PRICE_STALE_MS / 1000}s): ${stale.join(' ')}`);
    }
  } else {
    noPriceSinceMs = 0; // we have price, clear so 2-min timer doesn't run
  }

  // Periodic log every tick (~1s) so feed is frequent
  {
    const parts: string[] = [];
    for (const a of ASSETS) {
      const p = getPrice(a);
      const o = windowOpenPrices[a];
      if (p && o) {
        const s = ((p - o) / p * 100);
        parts.push(`${a}:${s.toFixed(3)}%`);
      } else {
        parts.push(`${a}:—`);
      }
    }
    console.log(`[B123c] ${minLeft.toFixed(1)}min left | ${parts.join(' ')} | size=$${positionSize}`);
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function startB123cRunner(): Promise<void> {
  console.log('');
  console.log('[B123c] ═══ B1c/B2c/B3c Chainlink Runner Starting ═══');
  console.log('[B123c] Strategy: clone of B1/B2/B3 with Chainlink prices, Polymarket only');
  console.log('[B123c] Price source: Chainlink RTDS only (no Binance fallback, same as B4)');
  console.log('[B123c] Blocking: in-memory only (no shared tables)');
  // Prefill dashboard cache so first tick has config (position size logged below after fetch)
  try {
    const fresh = await getB123cDashboardConfig();
    dashboardCache = { ...fresh, ts: Date.now() };
    console.log(`[B123c] Position size from config: $${dashboardCache.positionSize}`);
  } catch {
    console.warn('[B123c] Initial dashboard config fetch failed; first tick will retry');
  }
  if (!dashboardCache) console.log('[B123c] Position size: $5 (default until config loaded)');
  console.log('[B123c] Tiers: B1c(last 2.5min,96c/99c) B2c(last 5min,97c) B3c(last 8min,97c)');
  console.log('');

  // Refresh USDC allowance for CLOB so orders don't fail with "not enough balance / allowance" (B1c/2c/3c only; B4 untouched).
  try {
    await withPolyProxy(async () => {
      const client = await getClobClient();
      await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      console.log('[B123c] USDC balance allowance updated for CLOB');
    });
  } catch (e) {
    console.warn('[B123c] Balance allowance update failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  connectRTDS();
  await new Promise(r => setTimeout(r, 5_000));

  const live = ASSETS.filter(a => getPrice(a) != null);
  console.log(`[B123c] Chainlink live: ${live.length > 0 ? live.join(', ') : 'none yet (will retry)'}`);
  for (const a of live) console.log(`[B123c]   ${a}: $${getPrice(a)!.toFixed(2)}`);

  let tickCount = 0;

  const runTick = async () => {
    const tickStartMs = Date.now();
    tickCount++;
    try {
      await runOneTick(new Date(), tickCount);
    } catch (e) {
      console.error('[B123c] tick error:', e instanceof Error ? e.message : e);
      try { await logError(e, { bot: 'B1c', stage: 'tick' }); } catch {}
    }
    const elapsedMs = Date.now() - tickStartMs;
    const delayMs = Math.max(0, MIN_TICK_DELAY_MS - elapsedMs);
    setTimeout(runTick, delayMs);
  };

  runTick();

  const shutdown = () => {
    console.log('[B123c] shutting down');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
