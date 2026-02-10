/**
 * B4 paper trader: BTC, ETH, SOL.
 * - First 3 min: check every second for entry (any side >= 54¢). If never hit 54¢ → log NO_ENTRY.
 * - If entered: from 3 min to end of window, check every 30s if that side hits 60¢. If yes → log 60_POSSIBLE.
 * - If entered but never hit 60 by end of window → log LOSS.
 * Paper only – no real orders. Logs to b4-paper.log and Supabase.
 */
import 'dotenv/config';
import { appendFileSync } from 'fs';
import { getCurrentWindowEndUnix, getCurrentPolySlug, minutesLeftInWindow } from '../clock.js';
import { logB4Paper } from '../db/supabase.js';
import type { Asset } from '../kalshi/ticker.js';
import { getPolyMarketBySlug } from '../polymarket/gamma.js';

const LOG_PATH = 'b4-paper.log';
const BUY_THRESHOLD = 0.54 - 1e-6;
const SELL_AT = 0.6 - 1e-6;

const B4_ASSETS: Asset[] = ['BTC', 'ETH', 'SOL'];

/** First 3 minutes of window = minutes left in (12, 15]. */
function isFirst3Min(minutesLeft: number): boolean {
  return minutesLeft > 12 && minutesLeft <= 15;
}

function logLine(msg: string): void {
  const line = `${new Date().toISOString()} | ${msg}\n`;
  try {
    appendFileSync(LOG_PATH, line);
  } catch (e) {
    console.error('Log write failed:', e);
  }
}

type Direction = 'yes' | 'no';
type State = {
  windowUnix: number;
  entered: boolean;
  direction: Direction | null;
  sold: boolean;
  loggedCheck?: boolean;
  lastSampleSec?: number;
  loggedNoEntry?: boolean;
  last60Bucket?: number; // 30s bucket index after min 3 (0 = 180–209s, 1 = 210–239s, ...)
};

const stateByAsset: Partial<Record<Asset, State>> = {};

function getState(asset: Asset, windowUnix: number): State {
  let s = stateByAsset[asset];
  if (!s || s.windowUnix !== windowUnix) {
    s = { windowUnix, entered: false, direction: null, sold: false };
    stateByAsset[asset] = s;
  }
  return s;
}

/** Seconds into the current 15m window (0 at window start). */
function secondsIntoWindow(now: Date, windowUnix: number): number {
  const windowStartUnix = windowUnix - 900;
  return Math.floor(now.getTime() / 1000) - windowStartUnix;
}

async function fetchPrices(asset: Asset, now: Date): Promise<{ yesPrice: number; noPrice: number } | null> {
  const slug = getCurrentPolySlug(asset, now);
  let market;
  try {
    market = await getPolyMarketBySlug(slug);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    logLine(`B4 fetch failed asset=${asset} slug=${slug} err=${errMsg}`);
    return null;
  }
  const rawPrices = market?.outcomePrices;
  if (!Array.isArray(rawPrices) || rawPrices.length === 0) return null;
  let prices = rawPrices.map((p) => Number(p));
  const rawMax = Math.max(...prices);
  if (rawMax > 1.5) prices = prices.map((p) => p / 100);
  const p0 = prices[0] ?? 0;
  const p1 = prices[1] ?? 0;
  return { yesPrice: p0, noPrice: p1 };
}

async function tickAsset(asset: Asset, now: Date): Promise<void> {
  try {
    const windowUnix = getCurrentWindowEndUnix(now);
    const minutesLeft = minutesLeftInWindow(now);
    const sec = secondsIntoWindow(now, windowUnix);

    // Window transition: if we had a previous window with entered && !sold, log LOSS
    const prev = stateByAsset[asset];
    if (prev && prev.windowUnix !== windowUnix && prev.entered && !prev.sold) {
      logLine(`window=${prev.windowUnix} | asset=${asset} | event=LOSS | direction=${prev.direction ?? '—'} (entered, never hit 60)`);
      await logB4Paper({ window_unix: prev.windowUnix, asset, event: 'LOSS', direction: prev.direction, price: null });
    }

    const state = getState(asset, windowUnix);

    // ---------- First 3 minutes: entry at 54¢, and 60¢ if hit in same period ----------
    if (isFirst3Min(minutesLeft)) {
      const prices = await fetchPrices(asset, now);
      if (!prices) return;
      const { yesPrice, noPrice } = prices;
      const maxPrice = Math.max(yesPrice, noPrice);
      const maxIdx = yesPrice >= noPrice ? 0 : 1;

      if (!state.loggedCheck) {
        state.loggedCheck = true;
        logLine(`B4 check asset=${asset} slug=${getCurrentPolySlug(asset, now)} yes=${yesPrice.toFixed(3)} no=${noPrice.toFixed(3)}`);
      }
      const bucket = Math.floor(sec / 10) * 10;
      if (bucket >= 0 && state.lastSampleSec !== bucket) {
        (state as State).lastSampleSec = bucket;
        logLine(`B4 sample sec=${bucket} asset=${asset} max=${maxPrice.toFixed(3)}`);
      }

      if (!state.entered) {
        if (maxPrice >= BUY_THRESHOLD) {
          state.entered = true;
          state.direction = maxIdx === 0 ? 'yes' : 'no';
          const sidePrice = maxIdx === 0 ? yesPrice : noPrice;
          logLine(`window=${windowUnix} | asset=${asset} | event=BUY_56_POSSIBLE | direction=${state.direction} | price=${sidePrice.toFixed(3)}`);
          await logB4Paper({ window_unix: windowUnix, asset, event: 'BUY_56_POSSIBLE', direction: state.direction, price: sidePrice });
        }
      }

      if (state.entered && state.direction && !state.sold) {
        const sidePrice = state.direction === 'yes' ? yesPrice : noPrice;
        if (sidePrice >= SELL_AT) {
          state.sold = true;
          logLine(`window=${windowUnix} | asset=${asset} | event=60_POSSIBLE | direction=${state.direction} | price=${sidePrice.toFixed(3)}`);
          await logB4Paper({ window_unix: windowUnix, asset, event: '60_POSSIBLE', direction: state.direction, price: sidePrice });
        }
      }
      return;
    }

    // ---------- After first 3 min: NO_ENTRY once if never entered; every 30s check for 60 if entered ----------
    if (minutesLeft <= 0) return; // past window end, nothing to do

    if (!state.entered) {
      if (!state.loggedNoEntry) {
        (state as State).loggedNoEntry = true;
        logLine(`window=${windowUnix} | asset=${asset} | event=NO_ENTRY (never hit 54 in first 3 min)`);
        await logB4Paper({ window_unix: windowUnix, asset, event: 'NO_ENTRY', direction: null, price: null });
      }
      return;
    }

    if (!state.direction || state.sold) return;

    // Every 30 seconds from 3 min (sec 180, 210, 240, ...) check if our side hit 60
    if (sec < 180) return;
    const bucket60 = Math.floor((sec - 180) / 30);
    if (state.last60Bucket !== undefined && state.last60Bucket >= bucket60) return;
    (state as State).last60Bucket = bucket60;

    const prices = await fetchPrices(asset, now);
    if (!prices) return;
    const sidePrice = state.direction === 'yes' ? prices.yesPrice : prices.noPrice;
    if (sidePrice >= SELL_AT) {
      state.sold = true;
      logLine(`window=${windowUnix} | asset=${asset} | event=60_POSSIBLE | direction=${state.direction} | price=${sidePrice.toFixed(3)}`);
      await logB4Paper({ window_unix: windowUnix, asset, event: '60_POSSIBLE', direction: state.direction, price: sidePrice });
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    logLine(`B4 tickAsset failed asset=${asset} err=${errMsg}`);
  }
}

async function tick(now: Date): Promise<void> {
  try {
    await Promise.all(B4_ASSETS.map((asset) => tickAsset(asset, now)));
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    logLine(`B4 tick failed err=${errMsg}`);
  }
}

async function main(): Promise<void> {
  logLine('B4 paper started (BTC, ETH, SOL): first 3 min entry at 54¢, then every 30s check 60¢; NO_ENTRY / LOSS / 60_POSSIBLE');
  console.log('B4 paper trader running. Log:', LOG_PATH);
  while (true) {
    await tick(new Date());
    await new Promise((r) => setTimeout(r, 1000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
