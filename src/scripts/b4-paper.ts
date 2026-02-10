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
const BUY_THRESHOLD = 0.54;
const SELL_AT = 0.6;

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

async function tickAsset(asset: Asset, now: Date): Promise<void> {
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

  const [yesPrice, noPrice] = market.outcomePrices;
  if (yesPrice == null || noPrice == null) return;

  const state = getState(asset, windowUnix);

  // Once per asset per window: log that we're checking and current prices (so log isn't empty if no 54/60)
  if (!state.loggedCheck) {
    state.loggedCheck = true;
    logLine(`B4 check asset=${asset} slug=${slug} yes=${yesPrice.toFixed(3)} no=${noPrice.toFixed(3)}`);
  }

  if (!state.entered) {
    if (yesPrice >= BUY_THRESHOLD) {
      state.entered = true;
      state.direction = 'yes';
      logLine(`window=${windowUnix} | asset=${asset} | event=BUY_56_POSSIBLE | direction=yes | price=${yesPrice.toFixed(3)}`);
      await logB4Paper({ window_unix: windowUnix, asset, event: 'BUY_56_POSSIBLE', direction: 'yes', price: yesPrice });
    } else if (noPrice >= BUY_THRESHOLD) {
      state.entered = true;
      state.direction = 'no';
      logLine(`window=${windowUnix} | asset=${asset} | event=BUY_56_POSSIBLE | direction=no | price=${noPrice.toFixed(3)}`);
      await logB4Paper({ window_unix: windowUnix, asset, event: 'BUY_56_POSSIBLE', direction: 'no', price: noPrice });
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
}

async function tick(now: Date): Promise<void> {
  const minutesLeft = minutesLeftInWindow(now);
  if (!isB4Window(minutesLeft)) return;

  for (const asset of B4_ASSETS) {
    await tickAsset(asset, now);
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
