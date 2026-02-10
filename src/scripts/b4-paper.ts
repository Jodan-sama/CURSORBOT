/**
 * B4 paper trader: BTC only, first 3 min of each 15m window.
 * When yes or no price hits 54+ (0.54), we "would" buy at 56; when that side hits 60+, we "would" sell at 60.
 * Logs to b4-paper.log (one line per event). No real orders. Run with HTTP_PROXY/HTTPS_PROXY if needed.
 *
 *   node dist/scripts/b4-paper.js
 *   npm run b4-paper
 */
import 'dotenv/config';
import { appendFileSync } from 'fs';
import { getCurrentWindowEndUnix, getCurrentPolySlug, minutesLeftInWindow } from '../clock.js';
import { logB4Paper } from '../db/supabase.js';
import { getPolyMarketBySlug } from '../polymarket/gamma.js';

const LOG_PATH = 'b4-paper.log';
const BUY_THRESHOLD = 0.54;
const BUY_AT = 0.56;
const SELL_AT = 0.6;
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
};

let state: State = { windowUnix: 0, entered: false, direction: null, sold: false };

async function tick(now: Date): Promise<void> {
  const windowUnix = getCurrentWindowEndUnix(now);
  const minutesLeft = minutesLeftInWindow(now);

  if (state.windowUnix !== windowUnix) {
    state = { windowUnix, entered: false, direction: null, sold: false };
  }

  if (!isB4Window(minutesLeft)) return;

  try {
    const slug = getCurrentPolySlug('BTC', now);
    const market = await getPolyMarketBySlug(slug);
    const [yesPrice, noPrice] = market.outcomePrices;
    if (yesPrice == null || noPrice == null) return;

    if (!state.entered) {
      if (yesPrice >= BUY_THRESHOLD) {
        state.entered = true;
        state.direction = 'yes';
        logLine(`window=${windowUnix} | event=BUY_56_POSSIBLE | direction=yes | price=${yesPrice.toFixed(3)}`);
        await logB4Paper({ window_unix: windowUnix, event: 'BUY_56_POSSIBLE', direction: 'yes', price: yesPrice });
      } else if (noPrice >= BUY_THRESHOLD) {
        state.entered = true;
        state.direction = 'no';
        logLine(`window=${windowUnix} | event=BUY_56_POSSIBLE | direction=no | price=${noPrice.toFixed(3)}`);
        await logB4Paper({ window_unix: windowUnix, event: 'BUY_56_POSSIBLE', direction: 'no', price: noPrice });
      }
    }

    if (state.entered && state.direction && !state.sold) {
      const sidePrice = state.direction === 'yes' ? yesPrice : noPrice;
      if (sidePrice >= SELL_AT) {
        state.sold = true;
        logLine(`window=${windowUnix} | event=SELL_60_POSSIBLE | direction=${state.direction} | price=${sidePrice.toFixed(3)}`);
        await logB4Paper({ window_unix: windowUnix, event: 'SELL_60_POSSIBLE', direction: state.direction, price: sidePrice });
      }
    }
  } catch (e) {
    // skip tick on fetch/parse errors
  }
}

async function main(): Promise<void> {
  logLine('B4 paper started');
  console.log('B4 paper trader running (BTC, first 3 min, 54->56 buy / 60 sell). Log:', LOG_PATH);
  while (true) {
    await tick(new Date());
    await new Promise((r) => setTimeout(r, 1000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
