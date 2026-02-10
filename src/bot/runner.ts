/**
 * Main bot loop: B1/B2/B3 timing, spread checks, order placement (Kalshi + Polymarket), B3 blocking.
 */

import type { Asset } from '../kalshi/ticker.js';
import {
  minutesLeftInWindow,
  isB1Window,
  isB2Window,
  isB3Window,
  isB1MarketOrderWindow,
  getCurrentPolySlug,
} from '../clock.js';
import { getCurrentKalshiTicker, getKalshiMarket } from '../kalshi/market.js';
import { createKalshiOrder } from '../kalshi/orders.js';
import { fetchBinancePrice, strikeSpreadPct, isOutsideSpreadThreshold } from '../kalshi/spread.js';
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
  logPosition,
  setAssetBlock,
  isAssetBlocked,
  logError,
} from '../db/supabase.js';

const ASSETS: Asset[] = ['BTC', 'ETH', 'SOL'];

/** When false or unset, only trade on Kalshi (skip Polymarket). Set ENABLE_POLYMARKET=true to enable Poly. */
function isPolymarketEnabled(): boolean {
  const v = process.env.ENABLE_POLYMARKET;
  return v === 'true' || v === '1';
}

const B1_CHECK_INTERVAL_MS = 5_000;
const B2_CHECK_INTERVAL_MS = 30_000;
const B3_CHECK_INTERVAL_MS = 60_000;

/** In-memory: already placed an order this window for (bot, asset). Cleared when window changes. */
const enteredThisWindow = new Set<string>();

function windowKey(bot: string, asset: Asset, windowEndMs: number): string {
  return `${windowEndMs}-${bot}-${asset}`;
}

function getCurrentWindowEndMs(): number {
  const now = Date.now();
  const WINDOW_MS = 15 * 60 * 1000;
  const remainder = now % WINDOW_MS;
  return now - remainder + WINDOW_MS;
}

async function tryPlaceKalshi(
  ticker: string,
  asset: Asset,
  bot: 'B1' | 'B2' | 'B3',
  isMarket: boolean,
  limitPercent: number,
  size: number
): Promise<{ orderId?: string; filled?: boolean }> {
  const type = isMarket ? 'market' : 'limit';
  const yesPrice = isMarket ? undefined : Math.round(limitPercent);
  const res = await createKalshiOrder({
    ticker,
    side: 'yes',
    action: 'buy',
    count: Math.max(1, Math.floor(size)),
    type: type as 'limit' | 'market',
    yes_price: yesPrice ?? 50,
    no_price: yesPrice != null ? 100 - yesPrice : 50,
  });
  const orderId = res.order?.order_id;
  return { orderId, filled: res.order?.status === 'filled' };
}

async function tryPlacePolymarket(
  slug: string,
  asset: Asset,
  price: number,
  size: number
): Promise<{ orderId?: string }> {
  const parsed = await getPolyMarketBySlug(slug);
  const client = createPolyClobClient(getPolyClobConfigFromEnv());
  const params = orderParamsFromParsedMarket(parsed, price, size);
  const result = await createAndPostPolyOrder(client, params);
  return { orderId: result.orderID };
}

export async function runOneTick(now: Date): Promise<void> {
  if (await isEmergencyOff()) return;

  const minutesLeft = minutesLeftInWindow(now);
  const windowEndMs = getCurrentWindowEndMs();

  for (const asset of ASSETS) {
    if (await isAssetBlocked(asset)) continue;

    let kalshiTicker: string | null = null;
    let kalshiStrike: number | null = null;
    let kalshiBid: number | null = null;
    let polySlug: string | null = null;
    let currentPrice: number | null = null;
    let spreadPct: number | null = null;

    try {
      kalshiTicker = await getCurrentKalshiTicker(asset, undefined, now);
      polySlug = getCurrentPolySlug(asset, now);
      currentPrice = await fetchBinancePrice(asset);

      if (kalshiTicker) {
        const km = await getKalshiMarket(kalshiTicker);
        kalshiStrike = km.floor_strike ?? null;
        kalshiBid = km.yes_bid ?? null;
        if (kalshiStrike != null && currentPrice != null) {
          spreadPct = strikeSpreadPct(currentPrice, kalshiStrike);
        }
      }
    } catch (e) {
      await logError(e, { asset, stage: 'market_data' });
      continue;
    }

    if (spreadPct == null) continue;

    const sizeKalshiB1 = await getPositionSize('kalshi', 'B1', asset);
    const sizePolyB1 = await getPositionSize('polymarket', 'B1', asset);
    const sizeKalshiB2 = await getPositionSize('kalshi', 'B2', asset);
    const sizePolyB2 = await getPositionSize('polymarket', 'B2', asset);
    const sizeKalshiB3 = await getPositionSize('kalshi', 'B3', asset);
    const sizePolyB3 = await getPositionSize('polymarket', 'B3', asset);

    // --- B1: last 2.5 min, check every 5s, bid 90–96%, place 96% limit (or market in last 1 min) ---
    if (isB1Window(minutesLeft)) {
      const key = windowKey('B1', asset, windowEndMs);
      if (enteredThisWindow.has(key)) continue;
      if (!isOutsideSpreadThreshold('B1', asset, spreadPct)) continue;
      const bidPct = kalshiBid != null ? kalshiYesBidAsPercent(kalshiBid) : 0;
      if (bidPct < 90 || bidPct > 96) continue;

      const useMarket = isB1MarketOrderWindow(minutesLeft);
      if (kalshiTicker) {
        try {
          const { orderId } = await tryPlaceKalshi(kalshiTicker, asset, 'B1', useMarket, 96, sizeKalshiB1);
          enteredThisWindow.add(key);
          await logPosition({
            bot: 'B1',
            asset,
            venue: 'kalshi',
            strike_spread_pct: spreadPct,
            position_size: sizeKalshiB1,
            ticker_or_slug: kalshiTicker,
            order_id: orderId ?? undefined,
          });
          console.log(`B1 Kalshi ${asset} ${useMarket ? 'market' : '96% limit'} orderId=${orderId}`);
        } catch (e) {
          await logError(e, { bot: 'B1', asset, venue: 'kalshi' });
        }
      }
      if (isPolymarketEnabled() && polySlug) {
        try {
          const { orderId } = await tryPlacePolymarket(polySlug, asset, useMarket ? 0.99 : 0.96, sizePolyB1);
          enteredThisWindow.add(key);
          await logPosition({
            bot: 'B1',
            asset,
            venue: 'polymarket',
            strike_spread_pct: spreadPct,
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
      if (enteredThisWindow.has(key)) continue;
      if (!isOutsideSpreadThreshold('B2', asset, spreadPct)) continue;

      if (kalshiTicker) {
        try {
          const { orderId } = await tryPlaceKalshi(kalshiTicker, asset, 'B2', false, 97, sizeKalshiB2);
          enteredThisWindow.add(key);
          await logPosition({
            bot: 'B2',
            asset,
            venue: 'kalshi',
            strike_spread_pct: spreadPct,
            position_size: sizeKalshiB2,
            ticker_or_slug: kalshiTicker,
            order_id: orderId ?? undefined,
          });
          console.log(`B2 Kalshi ${asset} 97% orderId=${orderId}`);
        } catch (e) {
          await logError(e, { bot: 'B2', asset, venue: 'kalshi' });
        }
      }
      if (isPolymarketEnabled() && polySlug) {
        try {
          const { orderId } = await tryPlacePolymarket(polySlug, asset, 0.97, sizePolyB2);
          enteredThisWindow.add(key);
          await logPosition({
            bot: 'B2',
            asset,
            venue: 'polymarket',
            strike_spread_pct: spreadPct,
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
      if (enteredThisWindow.has(key)) continue;
      if (!isOutsideSpreadThreshold('B3', asset, spreadPct)) continue;

      let placed = false;
      if (kalshiTicker) {
        try {
          const { orderId } = await tryPlaceKalshi(kalshiTicker, asset, 'B3', false, 97, sizeKalshiB3);
          placed = true;
          enteredThisWindow.add(key);
          await logPosition({
            bot: 'B3',
            asset,
            venue: 'kalshi',
            strike_spread_pct: spreadPct,
            position_size: sizeKalshiB3,
            ticker_or_slug: kalshiTicker,
            order_id: orderId ?? undefined,
          });
          console.log(`B3 Kalshi ${asset} 97% orderId=${orderId}`);
        } catch (e) {
          await logError(e, { bot: 'B3', asset, venue: 'kalshi' });
        }
      }
      if (isPolymarketEnabled() && polySlug) {
        try {
          const { orderId } = await tryPlacePolymarket(polySlug, asset, 0.97, sizePolyB3);
          placed = true;
          enteredThisWindow.add(key);
          await logPosition({
            bot: 'B3',
            asset,
            venue: 'polymarket',
            strike_spread_pct: spreadPct,
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
        const blockUntil = new Date(now.getTime() + 30 * 60 * 1000);
        await setAssetBlock(asset, blockUntil);
        console.log(`B3 placed for ${asset}: block B1/B2 until ${blockUntil.toISOString()}`);
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

/** Run loop: B1 every 5s, B2 every 30s, B3 every 60s. */
export function startBotLoop(): void {
  let tickCount = 0;
  const interval = setInterval(async () => {
    tickCount += 1;
    const now = new Date();
    // Heartbeat every 60s so logs show the process is alive
    if (tickCount % 12 === 0) {
      console.log(`[cursorbot] alive | UTC ${now.toISOString()} | Kalshi only`);
    }
    const shouldB1 = true;
    const shouldB2 = tickCount % 6 === 0;
    const shouldB3 = tickCount % 12 === 0;
    if (shouldB1 || shouldB2 || shouldB3) {
      try {
        await runOneTick(now);
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
