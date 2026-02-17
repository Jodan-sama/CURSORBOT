/**
 * B4 Kalshi 46/50: BTC, ETH, SOL. Kalshi only. Position size $1 (1 contract) per asset.
 * One resting order per asset per round: place a single limit buy YES at 46¢ per asset.
 * When it fills: place a resting limit sell at 50¢ (4¢ spread). Polls every 1s.
 * Respects dashboard emergency off (stops placing/cancelling when on).
 *
 *   node dist/scripts/b4-kalshi-46-50.js
 */
import 'dotenv/config';
import { getCurrentWindowEndUnix, minutesLeftInWindow } from '../clock.js';
import { isEmergencyOff, logB4Paper } from '../db/supabase.js';
import type { Asset } from '../kalshi/ticker.js';
import { getCurrentKalshiTicker } from '../kalshi/market.js';
import {
  createKalshiOrder,
  getKalshiOrder,
  cancelKalshiOrder,
} from '../kalshi/orders.js';

const PROFIT_DOLLARS = 0.04;  // bought 46¢, sold 50¢
const LOSS_DOLLARS = -0.46;   // bought 46¢, never sold (cost basis)

const POLL_MS = 1000;
const BUY_PRICE = 46;   // 46¢ limit buy
const SELL_PRICE = 50;  // 50¢ limit sell
/** Position size $1 = 1 contract per side per asset */
const COUNT = 1;

const ASSETS: Asset[] = ['BTC', 'ETH', 'SOL'];

type WindowState = {
  windowUnix: number;
  orderId: string | null; // single 46¢ YES buy order
  sellOrderId: string | null; // 50¢ sell order; we check at end of window if filled
  done: boolean; // filled, placed 50 sell (or cancelled at end of window)
};

const stateByAsset: Partial<Record<Asset, WindowState>> = {};

function getWindowUnix(): number {
  return getCurrentWindowEndUnix(new Date());
}

async function runOneAsset(asset: Asset): Promise<void> {
  const now = new Date();
  const windowUnix = getWindowUnix();
  const minutesLeft = minutesLeftInWindow(now);

  let state = stateByAsset[asset];

  // New window: settle previous window's 50¢ sell (log profit/loss), then reset
  if (!state || state.windowUnix !== windowUnix) {
    if (state?.done && state.sellOrderId) {
      try {
        const sellOrder = await getKalshiOrder(state.sellOrderId);
        if (sellOrder && sellOrder.fill_count > 0) {
          await logB4Paper({ window_unix: state.windowUnix, asset, event: 'profit', direction: null, price: PROFIT_DOLLARS });
          console.log(`[B4 46/50] ${asset} window ${state.windowUnix} sold @50 → profit $${PROFIT_DOLLARS}`);
        } else {
          try { await cancelKalshiOrder(state.sellOrderId); } catch (_) {}
          await logB4Paper({ window_unix: state.windowUnix, asset, event: 'loss', direction: null, price: LOSS_DOLLARS });
          console.log(`[B4 46/50] ${asset} window ${state.windowUnix} never sold @50 → loss $${-LOSS_DOLLARS}`);
        }
      } catch (e) {
        console.error(`[B4 46/50] ${asset} settle sell failed`, e);
      }
    }
    if (state?.orderId) {
      try {
        await cancelKalshiOrder(state.orderId);
        console.log(`[B4 46/50] ${asset} new window, cancelled previous resting order`);
      } catch (_) {}
    }
    state = {
      windowUnix,
      orderId: null,
      sellOrderId: null,
      done: false,
    };
    stateByAsset[asset] = state;
  }

  if (state.done) return;

  const ticker = await getCurrentKalshiTicker(asset, undefined, now);
  if (!ticker) return;

  // Place single 46¢ YES order if we haven't yet (one resting order per asset per round)
  if (!state.orderId) {
    try {
      const res = await createKalshiOrder({
        ticker,
        side: 'yes',
        action: 'buy',
        count: COUNT,
        type: 'limit',
        yes_price: BUY_PRICE,
      });
      state.orderId = res.order?.order_id ?? null;
      if (state.orderId) {
        console.log(`[B4 46/50] ${asset} ${ticker} placed single YES @${BUY_PRICE} orderId=${state.orderId}`);
      }
    } catch (e) {
      console.error(`[B4 46/50] ${asset} place 46 order failed`, e);
      return;
    }
    return;
  }

  // Poll: check fill on the 46¢ order
  let order = null;
  try {
    order = await getKalshiOrder(state.orderId);
  } catch (_) {}

  const filled = order && order.fill_count > 0;

  if (filled) {
    const fillCount = order!.fill_count;
    try {
      const res = await createKalshiOrder({
        ticker,
        side: 'yes',
        action: 'sell',
        count: fillCount,
        type: 'limit',
        yes_price: SELL_PRICE,
      });
      state.sellOrderId = res.order?.order_id ?? null;
      console.log(`[B4 46/50] ${asset} YES filled ${fillCount} @46, placed sell @${SELL_PRICE}`);
    } catch (e) {
      console.error(`[B4 46/50] ${asset} place sell failed after fill`, e);
    }
    state.done = true;
    state.orderId = null;
    return;
  }

  // Near end of window: cancel resting order if not filled; log no_fill
  if (minutesLeft < 1 && state.orderId) {
    try {
      await cancelKalshiOrder(state.orderId);
      await logB4Paper({ window_unix: state.windowUnix, asset, event: 'no_fill', direction: null, price: null });
      console.log(`[B4 46/50] ${asset} window ending, cancelled resting order (no fill)`);
    } catch (_) {}
    state.done = true;
    state.orderId = null;
  }
}

async function runOne(): Promise<void> {
  try {
    if (await isEmergencyOff()) return;
  } catch (_) {
    return; // e.g. Supabase down; skip tick
  }

  for (const asset of ASSETS) {
    try {
      await runOneAsset(asset);
    } catch (e) {
      console.error(`[B4 46/50] ${asset} tick error`, e);
    }
  }
}

async function main(): Promise<void> {
  console.log('[B4 46/50] BTC + ETH + SOL, Kalshi, $1 per asset. One resting YES @46 per asset; on fill place 50 sell. Emergency off respected. Poll every', POLL_MS, 'ms');
  while (true) {
    try {
      await runOne();
    } catch (e) {
      console.error('[B4 46/50] tick error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
