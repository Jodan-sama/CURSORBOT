/**
 * B4 paper trader: BTC, ETH, SOL. First 3 min of each 15m window.
 * When yes or no price hits 54+ (0.54), we "would" buy at 56; when that side hits 60+, we "would" sell at 60.
 * Paper only – no real orders. Logs to b4-paper.log and Supabase. Run with HTTP_PROXY/HTTPS_PROXY if needed.
 */
import 'dotenv/config';
import { appendFileSync } from 'fs';
import { getCurrentWindowEndUnix, getCurrentPolySlug, minutesLeftInWindow } from '../clock.js';
import { logB4Paper } from '../db/supabase.js';
import type { Asset } from '../kalshi/ticker.js';
import { getPolyMarketBySlug } from '../polymarket/gamma.js';

const LOG_PATH = 'b4-paper.log';
/** Any price >= this counts as 54¢ (use epsilon so 0.54 or float 0.5399... both count). */
const BUY_THRESHOLD = 0.54 - 1e-6;
const SELL_AT = 0.6 - 1e-6;

const B4_ASSETS: Asset[] = ['BTC', 'ETH', 'SOL'];

/** First 3 minutes of window = minutes left in (12, 15]. */
function isB4Window(minutesLeft: number): boolean {
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
  lastSampleSec?: number; // last sec we logged a B4 sample (multiples of 10)
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

async function tickAsset(asset: Asset, now: Date): Promise<void> {
  try {
    const windowUnix = getCurrentWindowEndUnix(now);
    const minutesLeft = minutesLeftInWindow(now);

    if (!isB4Window(minutesLeft)) return;

    const slug = getCurrentPolySlug(asset, now);
    let market;
    try {
      market = await getPolyMarketBySlug(slug);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logLine(`B4 fetch failed asset=${asset} slug=${slug} err=${errMsg}`);
      return;
    }

    const rawPrices = market?.outcomePrices;
    if (!Array.isArray(rawPrices) || rawPrices.length === 0) return;

    // Use full array: any outcome can hit 54+. Coerce to number. Gamma may return 0-1 (0.54) or 0-100 (54).
    let prices = rawPrices.map((p) => Number(p));
  if (prices.length === 0) return;
  const rawMax = Math.max(...prices);
  if (rawMax > 1.5) prices = prices.map((p) => p / 100);
  const maxPrice = Math.max(...prices);
  const maxIdx = prices.indexOf(maxPrice);
  const p0 = prices[0] ?? 0;
  const p1 = prices[1] ?? 0;
  const yesPrice = p0;
  const noPrice = p1;

  const state = getState(asset, windowUnix);
  const sec = secondsIntoWindow(now, windowUnix);

  // Once per asset per window: log raw API view so we can see exact format/order
  if (!state.loggedCheck) {
    state.loggedCheck = true;
    logLine(`B4 check asset=${asset} slug=${slug} rawPrices=[${prices.map((p) => p.toFixed(3)).join(',')}] outcomes=${JSON.stringify(market.outcomes ?? [])} yes=${yesPrice.toFixed(3)} no=${noPrice.toFixed(3)}`);
  }

  // Every 10 seconds: sample so we see we're sampling the whole 3 min
  const bucket = Math.floor(sec / 10) * 10;
  if (sec >= 0 && sec <= 179 && bucket >= 0 && state.lastSampleSec !== bucket) {
    (state as State).lastSampleSec = bucket;
    logLine(`B4 sample sec=${bucket} asset=${asset} max=${maxPrice.toFixed(3)} yes=${yesPrice.toFixed(3)} no=${noPrice.toFixed(3)}`);
  }

  // Trigger when ANY outcome is >= 0.54 (54¢ or above). Use max so we don't rely on order.
  if (!state.entered) {
    if (maxPrice >= BUY_THRESHOLD) {
      state.entered = true;
      state.direction = maxIdx === 0 ? 'yes' : 'no';
      const sidePrice = maxIdx === 0 ? yesPrice : noPrice;
      logLine(`window=${windowUnix} | asset=${asset} | event=BUY_56_POSSIBLE | direction=${state.direction} | price=${sidePrice.toFixed(3)} (maxIdx=${maxIdx})`);
      await logB4Paper({ window_unix: windowUnix, asset, event: 'BUY_56_POSSIBLE', direction: state.direction, price: sidePrice });
    }
  }

  if (state.entered && state.direction && !state.sold) {
    const sidePrice = state.direction === 'yes' ? yesPrice : noPrice;
    if (sidePrice >= SELL_AT) {
      state.sold = true;
      logLine(`window=${windowUnix} | asset=${asset} | event=SELL_60_POSSIBLE | direction=${state.direction} | price=${sidePrice.toFixed(3)}`);
      await logB4Paper({ window_unix: windowUnix, asset, event: 'SELL_60_POSSIBLE', direction: state.direction, price: sidePrice });
    }
  }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    logLine(`B4 tickAsset failed asset=${asset} err=${errMsg}`);
  }
}

async function tick(now: Date): Promise<void> {
  try {
    const minutesLeft = minutesLeftInWindow(now);
    if (!isB4Window(minutesLeft)) return;

    // Check all three assets in parallel; one failure must not kill the process
    await Promise.all(B4_ASSETS.map((asset) => tickAsset(asset, now)));
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    logLine(`B4 tick failed err=${errMsg}`);
  }
}

async function main(): Promise<void> {
  logLine('B4 paper started (BTC, ETH, SOL)');
  console.log('B4 paper trader running (BTC/ETH/SOL, first 3 min, 54->56 buy / 60 sell). Log:', LOG_PATH);
  while (true) {
    await tick(new Date());
    await new Promise((r) => setTimeout(r, 1000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
