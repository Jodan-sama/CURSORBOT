/**
 * Main bot loop: B1/B2/B3 timing, spread checks, order placement (Kalshi + Polymarket), B3 blocking.
 * Entry logic is Kalshi-only (spread from Kalshi strike + Binance price). Polymarket mirrors those
 * entries: same side/window, Poly sizes from dashboard; we only place Poly when we have Kalshi ticker.
 */

import type { Asset } from '../kalshi/ticker.js';
import {
  minutesLeftInWindow,
  isB1Window,
  isB2Window,
  isB3Window,
  isB1MarketOrderWindow,
  getCurrentPolySlug,
  isBlackoutWindow,
} from '../clock.js';
import { getCurrentKalshiTicker, getKalshiMarket } from '../kalshi/market.js';
import { parseKalshiTicker, isReasonableStrike } from '../kalshi/ticker.js';
import { createKalshiOrder } from '../kalshi/orders.js';
import { fetchBinancePrice, strikeSpreadPctSigned, isOutsideSpreadThreshold } from '../kalshi/spread.js';
import { kalshiYesBidAsPercent } from '../kalshi/market.js';
import { getPolyMarketBySlug } from '../polymarket/gamma.js';
import {
  createPolyClobClient,
  getPolyClobConfigFromEnv,
  createAndPostPolyOrder,
  orderParamsFromParsedMarket,
} from '../polymarket/clob.js';
import {
  isEmergencyOff,
  getPositionSize,
  getSpreadThresholds,
  logPosition,
  setAssetBlock,
  isAssetBlocked,
  logError,
} from '../db/supabase.js';

const ASSETS: Asset[] = ['BTC', 'ETH', 'SOL'];

/** When false or unset, only trade on Kalshi (skip Polymarket). Set ENABLE_POLYMARKET=true to enable Poly. */
function isPolymarketEnabled(): boolean {
  const v = process.env.ENABLE_POLYMARKET?.trim().toLowerCase();
  return v === 'true' || v === '1';
}

const B1_CHECK_INTERVAL_MS = 5_000;
const B2_CHECK_INTERVAL_MS = 30_000;
const B3_CHECK_INTERVAL_MS = 60_000;

/** Failsafe: never enter if |spread| > this (e.g. bad data). Also never enter when spread is 0. */
const MAX_SPREAD_PCT = 2;

/** After B2 places for an asset, B1 is delayed for this long (same asset). */
const B1_DELAY_AFTER_B2_MS = 15 * 60 * 1000;

/** In-memory: already placed an order this window for (bot, asset). Cleared when window changes. */
const enteredThisWindow = new Set<string>();

/** In-memory: timestamp (ms) when B2 last placed for each asset. B1 skips that asset for 15 min after. */
const lastB2OrderByAsset = new Map<Asset, number>();

function windowKey(bot: string, asset: Asset, windowEndMs: number): string {
  return `${windowEndMs}-${bot}-${asset}`;
}

function getCurrentWindowEndMs(): number {
  const now = Date.now();
  const WINDOW_MS = 15 * 60 * 1000;
  const remainder = now % WINDOW_MS;
  return now - remainder + WINDOW_MS;
}

/** Side from signed spread: positive → Yes, negative → No. We only place when |spread| > threshold. */
function sideFromSignedSpread(signedSpreadPct: number): 'yes' | 'no' {
  return signedSpreadPct >= 0 ? 'yes' : 'no';
}

async function tryPlaceKalshi(
  ticker: string,
  asset: Asset,
  bot: 'B1' | 'B2' | 'B3',
  isMarket: boolean,
  limitPercent: number,
  size: number,
  side: 'yes' | 'no'
): Promise<{ orderId?: string; filled?: boolean }> {
  const type = isMarket ? 'market' : 'limit';
  const priceCents = isMarket ? undefined : Math.round(limitPercent);
  const res = await createKalshiOrder({
    ticker,
    side,
    action: 'buy',
    count: Math.max(1, Math.floor(size)),
    type: type as 'limit' | 'market',
    yes_price: side === 'yes' ? priceCents ?? 50 : undefined,
    no_price: side === 'no' ? priceCents ?? 50 : undefined,
  });
  const orderId = res.order?.order_id;
  return { orderId, filled: res.order?.status === 'filled' };
}

/** Run fn with proxy set (only CLOB/Polymarket traffic); rest of bot uses direct. */
async function withPolyProxy<T>(fn: () => Promise<T>): Promise<T> {
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '';
  if (!proxy) return fn();
  const { ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } = await import('undici');
  const prev = getGlobalDispatcher();
  try {
    setGlobalDispatcher(new ProxyAgent(proxy));
    return await fn();
  } finally {
    setGlobalDispatcher(prev);
  }
}

async function tryPlacePolymarket(
  slug: string,
  asset: Asset,
  price: number,
  size: number,
  side: 'yes' | 'no'
): Promise<{ orderId?: string }> {
  const parsed = await getPolyMarketBySlug(slug);
  const client = createPolyClobClient(getPolyClobConfigFromEnv());
  const params = orderParamsFromParsedMarket(parsed, price, size, side);
  return withPolyProxy(() => createAndPostPolyOrder(client, params).then((r) => ({ orderId: r.orderID })));
}

export async function runOneTick(now: Date, tickCount: number = 0): Promise<void> {
  if (await isEmergencyOff()) return;
  if (isBlackoutWindow(now)) {
    if (tickCount % 12 === 0) console.log('[tick] blackout 08:00–08:15 MST (Utah) Mon–Fri; no trades');
    return;
  }

  const minutesLeft = minutesLeftInWindow(now);
  const windowEndMs = getCurrentWindowEndMs();
  const spreadThresholds = await getSpreadThresholds();

  for (const asset of ASSETS) {
    if (await isAssetBlocked(asset)) {
      if (tickCount % 12 === 0) console.log(`[tick] ${asset} skipped (B3 cooldown, blocked 1h)`);
      continue;
    }

    let kalshiTicker: string | null = null;
    let kalshiStrike: number | null = null;
    let kalshiBid: number | null = null;
    let polySlug: string | null = null;
    let currentPrice: number | null = null;
    /** Signed spread % from Kalshi strike + Binance price. One spread for both Kalshi and Poly (Poly mirrors Kalshi; we do not compute a separate Polymarket spread). */
    let signedSpreadPct: number | null = null;

    try {
      kalshiTicker = await getCurrentKalshiTicker(asset, undefined, now);
      polySlug = getCurrentPolySlug(asset, now);
      currentPrice = await fetchBinancePrice(asset);

      if (kalshiTicker) {
        const km = await getKalshiMarket(kalshiTicker);
        const parsed = parseKalshiTicker(kalshiTicker);
        const tickerStrike = parsed?.strikeFromTicker;
        const floorStrike = km.floor_strike ?? null;
        // Ticker is exact for the contract; floor_strike can be wrong (e.g. 15 for SOL). Prefer ticker when reasonable, else floor_strike. Same API load (we already fetch market for yes_bid).
        const useTickerStrike =
          tickerStrike != null && isReasonableStrike(asset, tickerStrike);
        const validFloor =
          floorStrike != null &&
          floorStrike !== 0 &&
          isReasonableStrike(asset, floorStrike);
        kalshiStrike = (useTickerStrike ? tickerStrike : null) ?? (validFloor ? floorStrike : null);
        kalshiBid = km.yes_bid ?? null;
        if (kalshiStrike != null && currentPrice != null) {
          signedSpreadPct = strikeSpreadPctSigned(currentPrice, kalshiStrike);
        }
      }
    } catch (e) {
      await logError(e, { asset, stage: 'market_data' });
      continue;
    }

    if (signedSpreadPct == null) continue;
    const spreadMagnitude = Math.abs(signedSpreadPct);
    // Failsafe: never enter on 0 spread or |spread| > 2% (bad/stale data).
    if (spreadMagnitude === 0) {
      if (tickCount % 12 === 0) console.log(`[tick] ${asset} skip: spread is 0 (failsafe)`);
      continue;
    }
    if (spreadMagnitude > MAX_SPREAD_PCT) {
      if (tickCount % 12 === 0) console.log(`[tick] ${asset} skip: |spread| ${spreadMagnitude.toFixed(2)}% > ${MAX_SPREAD_PCT}% (failsafe)`);
      continue;
    }
    const side = sideFromSignedSpread(signedSpreadPct);

    const sizeKalshiB1 = await getPositionSize('kalshi', 'B1', asset);
    const sizePolyB1 = await getPositionSize('polymarket', 'B1', asset);
    const sizeKalshiB2 = await getPositionSize('kalshi', 'B2', asset);
    const sizePolyB2 = await getPositionSize('polymarket', 'B2', asset);
    const sizeKalshiB3 = await getPositionSize('kalshi', 'B3', asset);
    const sizePolyB3 = await getPositionSize('polymarket', 'B3', asset);

    // --- B1: last 2.5 min, check every 5s, bid 90–96%, place 96% limit (or market in last 1 min) ---
    if (isB1Window(minutesLeft)) {
      const key = windowKey('B1', asset, windowEndMs);
      const t = lastB2OrderByAsset.get(asset);
      if (t != null && now.getTime() - t < B1_DELAY_AFTER_B2_MS) {
        if (tickCount % 6 === 0) {
          const minLeft = Math.ceil((B1_DELAY_AFTER_B2_MS - (now.getTime() - t)) / 60000);
          console.log(`[tick] B1 ${asset} skip: 15 min delay after B2 order (${minLeft} min left)`);
        }
        continue;
      }
      const outsideB1 = isOutsideSpreadThreshold('B1', asset, spreadMagnitude, spreadThresholds);
      const bidPct = kalshiBid != null ? kalshiYesBidAsPercent(kalshiBid) : 0;
      const bidOk = bidPct >= 90 && bidPct <= 96;
      if (enteredThisWindow.has(key)) continue;
      if (!outsideB1) {
        if (tickCount % 6 === 0) console.log(`[tick] B1 ${asset} skip: spread ${signedSpreadPct.toFixed(2)}% inside threshold`);
        continue;
      }
      if (!bidOk) {
        if (tickCount % 6 === 0) console.log(`[tick] B1 ${asset} skip: bid ${bidPct}% not in 90-96`);
        continue;
      }

      const useMarket = isB1MarketOrderWindow(minutesLeft);
      if (kalshiTicker) {
        try {
          const { orderId } = await tryPlaceKalshi(kalshiTicker, asset, 'B1', useMarket, 96, sizeKalshiB1, side);
          enteredThisWindow.add(key);
          await logPosition({
            bot: 'B1',
            asset,
            venue: 'kalshi',
            strike_spread_pct: signedSpreadPct,
            position_size: sizeKalshiB1,
            ticker_or_slug: kalshiTicker,
            order_id: orderId ?? undefined,
          });
          console.log(`B1 Kalshi ${asset} ${side} ${useMarket ? 'market' : '96% limit'} orderId=${orderId}`);
        } catch (e) {
          await logError(e, { bot: 'B1', asset, venue: 'kalshi' });
        }
      }
      // Poly mirrors Kalshi: same entry (we use Kalshi data); only place when we have Kalshi ticker.
      if (kalshiTicker && isPolymarketEnabled() && polySlug) {
        try {
          const { orderId } = await tryPlacePolymarket(polySlug, asset, useMarket ? 0.99 : 0.96, sizePolyB1, side);
          enteredThisWindow.add(key);
          await logPosition({
            bot: 'B1',
            asset,
            venue: 'polymarket',
            strike_spread_pct: signedSpreadPct,
            position_size: sizePolyB1,
            ticker_or_slug: polySlug,
            order_id: orderId,
          });
          console.log(`B1 Poly ${asset} orderId=${orderId}`);
        } catch (e) {
          await logError(e, { bot: 'B1', asset, venue: 'polymarket' });
        }
      }
    }

    // --- B2: last 5 min, check every 30s, place 97% limit ---
    if (isB2Window(minutesLeft)) {
      const key = windowKey('B2', asset, windowEndMs);
      const outsideB2 = isOutsideSpreadThreshold('B2', asset, spreadMagnitude, spreadThresholds);
      if (enteredThisWindow.has(key)) continue;
      if (!outsideB2) {
        if (tickCount % 6 === 0) console.log(`[tick] B2 ${asset} skip: spread ${signedSpreadPct.toFixed(2)}% inside threshold`);
        continue;
      }

      if (kalshiTicker) {
        try {
          const { orderId } = await tryPlaceKalshi(kalshiTicker, asset, 'B2', false, 97, sizeKalshiB2, side);
          enteredThisWindow.add(key);
          lastB2OrderByAsset.set(asset, now.getTime());
          await logPosition({
            bot: 'B2',
            asset,
            venue: 'kalshi',
            strike_spread_pct: signedSpreadPct,
            position_size: sizeKalshiB2,
            ticker_or_slug: kalshiTicker,
            order_id: orderId ?? undefined,
          });
          console.log(`B2 Kalshi ${asset} ${side} 97% orderId=${orderId}`);
        } catch (e) {
          await logError(e, { bot: 'B2', asset, venue: 'kalshi' });
        }
      }
      // Poly mirrors Kalshi: same entry condition; only place when we have Kalshi ticker.
      if (kalshiTicker && isPolymarketEnabled() && polySlug) {
        try {
          const { orderId } = await tryPlacePolymarket(polySlug, asset, 0.97, sizePolyB2, side);
          enteredThisWindow.add(key);
          lastB2OrderByAsset.set(asset, now.getTime());
          await logPosition({
            bot: 'B2',
            asset,
            venue: 'polymarket',
            strike_spread_pct: signedSpreadPct,
            position_size: sizePolyB2,
            ticker_or_slug: polySlug,
            order_id: orderId,
          });
          console.log(`B2 Poly ${asset} orderId=${orderId}`);
        } catch (e) {
          await logError(e, { bot: 'B2', asset, venue: 'polymarket' });
        }
      }
    }

    // --- B3: last 8 min, check every 1 min, place 97% limit; on place set block B2 15min, B1 30min ---
    if (isB3Window(minutesLeft)) {
      const key = windowKey('B3', asset, windowEndMs);
      const outsideB3 = isOutsideSpreadThreshold('B3', asset, spreadMagnitude, spreadThresholds);
      if (enteredThisWindow.has(key)) continue;
      if (!outsideB3) {
        if (tickCount % 12 === 0) console.log(`[tick] B3 ${asset} skip: spread ${signedSpreadPct.toFixed(2)}% inside threshold`);
        continue;
      }

      let placed = false;
      if (kalshiTicker) {
        try {
          const { orderId } = await tryPlaceKalshi(kalshiTicker, asset, 'B3', false, 97, sizeKalshiB3, side);
          placed = true;
          enteredThisWindow.add(key);
          await logPosition({
            bot: 'B3',
            asset,
            venue: 'kalshi',
            strike_spread_pct: signedSpreadPct,
            position_size: sizeKalshiB3,
            ticker_or_slug: kalshiTicker,
            order_id: orderId ?? undefined,
          });
          console.log(`B3 Kalshi ${asset} ${side} 97% orderId=${orderId}`);
        } catch (e) {
          await logError(e, { bot: 'B3', asset, venue: 'kalshi' });
        }
      }
      // Poly mirrors Kalshi: same entry condition; only place when we have Kalshi ticker.
      if (kalshiTicker && isPolymarketEnabled() && polySlug) {
        try {
          const { orderId } = await tryPlacePolymarket(polySlug, asset, 0.97, sizePolyB3, side);
          placed = true;
          enteredThisWindow.add(key);
          await logPosition({
            bot: 'B3',
            asset,
            venue: 'polymarket',
            strike_spread_pct: signedSpreadPct,
            position_size: sizePolyB3,
            ticker_or_slug: polySlug,
            order_id: orderId,
          });
          console.log(`B3 Poly ${asset} orderId=${orderId}`);
        } catch (e) {
          await logError(e, { bot: 'B3', asset, venue: 'polymarket' });
        }
      }
      if (placed) {
        const blockUntil = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour
        await setAssetBlock(asset, blockUntil);
        console.log(`B3 placed for ${asset}: block B1/B2 1h until ${blockUntil.toISOString()}`);
      }
    }
  }

  // Prune old window keys (older than current window)
  const cutoff = windowEndMs - 15 * 60 * 1000;
  for (const k of enteredThisWindow) {
    const ms = parseInt(k.split('-')[0], 10);
    if (ms < cutoff) enteredThisWindow.delete(k);
  }
}

/** Run loop: B1 every 5s, B2 every 30s, B3 every 30s (so we check in the first minute of the 8-min window). */
export function startBotLoop(): void {
  let tickCount = 0;
  const interval = setInterval(async () => {
    tickCount += 1;
    const now = new Date();
    // Heartbeat every 60s so logs show the process is alive
    if (tickCount % 12 === 0) {
      const venue = isPolymarketEnabled() ? 'Kalshi + Polymarket' : 'Kalshi only';
      console.log(`[cursorbot] alive | UTC ${now.toISOString()} | ${venue}`);
    }
    const shouldB1 = true;
    const shouldB2 = tickCount % 6 === 0;
    const shouldB3 = tickCount % 6 === 0; // every 30s so B3 checks during full 8 min (incl. 8-min-left)
    if (shouldB1 || shouldB2 || shouldB3) {
      try {
        await runOneTick(now, tickCount);
      } catch (e) {
        await logError(e, { stage: 'runOneTick' });
      }
    }
  }, B1_CHECK_INTERVAL_MS);

  const shutdown = () => {
    clearInterval(interval);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
