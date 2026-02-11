/**
 * B4 Kalshi 46/50: BTC only, Kalshi only. Position size $1 (1 contract).
 * At the start of each 15m window: place two resting limit buys at 46¢ (one YES, one NO).
 * As soon as one fills: cancel the other, place a resting limit sell at 50¢ for the filled side (min 4¢ spread).
 * Polls every 1s. Respects dashboard emergency off (stops placing/cancelling when on).
 *
 *   node dist/scripts/b4-kalshi-46-50.js
 */
import 'dotenv/config';
import { getCurrentWindowEndUnix, minutesLeftInWindow } from '../clock.js';
import { isEmergencyOff } from '../db/supabase.js';
import { getCurrentKalshiTicker } from '../kalshi/market.js';
import {
  createKalshiOrder,
  getKalshiOrder,
  cancelKalshiOrder,
} from '../kalshi/orders.js';

const POLL_MS = 1000;
const BUY_PRICE = 46;   // 46¢ limit buy
const SELL_PRICE = 50;  // 50¢ limit sell
/** Position size $1 = 1 contract per side */
const COUNT = 1;

type WindowState = {
  windowUnix: number;
  orderIdYes: string | null;
  orderIdNo: string | null;
  done: boolean; // filled one, cancelled other, placed 50 sell
};

let state: WindowState | null = null;

function getWindowUnix(): number {
  return getCurrentWindowEndUnix(new Date());
}

async function runOne(): Promise<void> {
  try {
    if (await isEmergencyOff()) return;
  } catch (_) {
    return; // e.g. Supabase down; skip tick
  }

  const now = new Date();
  const windowUnix = getWindowUnix();
  const minutesLeft = minutesLeftInWindow(now);

  // Reset when we enter a new window; cancel any previous window's resting orders
  if (!state || state.windowUnix !== windowUnix) {
    if (state?.orderIdYes || state?.orderIdNo) {
      try {
        if (state.orderIdYes) await cancelKalshiOrder(state.orderIdYes);
        if (state.orderIdNo) await cancelKalshiOrder(state.orderIdNo);
        console.log('[B4 46/50] new window, cancelled previous resting orders');
      } catch (_) {}
    }
    state = {
      windowUnix,
      orderIdYes: null,
      orderIdNo: null,
      done: false,
    };
  }

  if (state.done) return;

  const ticker = await getCurrentKalshiTicker('BTC', undefined, now);
  if (!ticker) return;

  // Place both 46¢ orders if we haven't yet
  if (!state.orderIdYes && !state.orderIdNo) {
    try {
      const resYes = await createKalshiOrder({
        ticker,
        side: 'yes',
        action: 'buy',
        count: COUNT,
        type: 'limit',
        yes_price: BUY_PRICE,
      });
      const resNo = await createKalshiOrder({
        ticker,
        side: 'no',
        action: 'buy',
        count: COUNT,
        type: 'limit',
        no_price: BUY_PRICE,
      });
      state.orderIdYes = resYes.order?.order_id ?? null;
      state.orderIdNo = resNo.order?.order_id ?? null;
      if (state.orderIdYes && state.orderIdNo) {
        console.log(`[B4 46/50] ${ticker} placed YES @${BUY_PRICE} no=${state.orderIdNo} yes=${state.orderIdYes}`);
      }
    } catch (e) {
      console.error('[B4 46/50] place 46 orders failed', e);
      return;
    }
    return;
  }

  // Poll: check fill on each order (404 = order gone, e.g. already cancelled)
  let orderYes = null;
  let orderNo = null;
  try {
    if (state.orderIdYes) orderYes = await getKalshiOrder(state.orderIdYes);
  } catch (_) {}
  try {
    if (state.orderIdNo) orderNo = await getKalshiOrder(state.orderIdNo);
  } catch (_) {}

  const fillYes = orderYes && orderYes.fill_count > 0;
  const fillNo = orderNo && orderNo.fill_count > 0;

  if (fillYes) {
    const fillCount = orderYes!.fill_count;
    try {
      if (state.orderIdNo) {
        await cancelKalshiOrder(state.orderIdNo);
        console.log(`[B4 46/50] cancelled NO order ${state.orderIdNo}`);
      }
      await createKalshiOrder({
        ticker,
        side: 'yes',
        action: 'sell',
        count: fillCount,
        type: 'limit',
        yes_price: SELL_PRICE,
      });
      console.log(`[B4 46/50] YES filled ${fillCount} @46, placed sell @${SELL_PRICE}`);
    } catch (e) {
      console.error('[B4 46/50] cancel/sell failed after YES fill', e);
    }
    state.done = true;
    state.orderIdYes = null;
    state.orderIdNo = null;
    return;
  }

  if (fillNo) {
    const fillCount = orderNo!.fill_count;
    try {
      if (state.orderIdYes) {
        await cancelKalshiOrder(state.orderIdYes);
        console.log(`[B4 46/50] cancelled YES order ${state.orderIdYes}`);
      }
      await createKalshiOrder({
        ticker,
        side: 'no',
        action: 'sell',
        count: fillCount,
        type: 'limit',
        no_price: SELL_PRICE,
      });
      console.log(`[B4 46/50] NO filled ${fillCount} @46, placed sell @${SELL_PRICE}`);
    } catch (e) {
      console.error('[B4 46/50] cancel/sell failed after NO fill', e);
    }
    state.done = true;
    state.orderIdYes = null;
    state.orderIdNo = null;
    return;
  }

  // Near end of window: cancel both resting orders if neither filled
  if (minutesLeft < 1 && (state.orderIdYes || state.orderIdNo)) {
    try {
      if (state.orderIdYes) await cancelKalshiOrder(state.orderIdYes);
      if (state.orderIdNo) await cancelKalshiOrder(state.orderIdNo);
      console.log(`[B4 46/50] window ending, cancelled resting orders`);
    } catch (_) {}
    state.done = true;
    state.orderIdYes = null;
    state.orderIdNo = null;
  }
}

async function main(): Promise<void> {
  console.log('[B4 46/50] BTC only, Kalshi, $1 (1 contract). Place 46 yes+no; on first fill cancel other, place 50 sell. Emergency off respected. Poll every', POLL_MS, 'ms');
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
