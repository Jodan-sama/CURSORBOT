/**
 * B4 Kalshi 46/50: BTC and ETH, Kalshi only. Position size $1 (1 contract) per asset.
 * At the start of each 15m window: place two resting limit buys at 46¢ (one YES, one NO) per asset.
 * As soon as one fills: cancel the other, place a resting limit sell at 50¢ for the filled side (min 4¢ spread).
 * Polls every 1s. Respects dashboard emergency off (stops placing/cancelling when on).
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

const ASSETS: Asset[] = ['BTC', 'ETH'];

type WindowState = {
  windowUnix: number;
  orderIdYes: string | null;
  orderIdNo: string | null;
  sellOrderId: string | null; // 50¢ sell order; we check at end of window if filled
  done: boolean; // filled one, cancelled other, placed 50 sell (or cancelled both)
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
    if (state?.orderIdYes || state?.orderIdNo) {
      try {
        if (state.orderIdYes) await cancelKalshiOrder(state.orderIdYes);
        if (state.orderIdNo) await cancelKalshiOrder(state.orderIdNo);
        console.log(`[B4 46/50] ${asset} new window, cancelled previous resting orders`);
      } catch (_) {}
    }
    state = {
      windowUnix,
      orderIdYes: null,
      orderIdNo: null,
      sellOrderId: null,
      done: false,
    };
    stateByAsset[asset] = state;
  }

  if (state.done) return;

  const ticker = await getCurrentKalshiTicker(asset, undefined, now);
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
        console.log(`[B4 46/50] ${asset} ${ticker} placed YES @${BUY_PRICE} no=${state.orderIdNo} yes=${state.orderIdYes}`);
      }
    } catch (e) {
      console.error(`[B4 46/50] ${asset} place 46 orders failed`, e);
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
        console.log(`[B4 46/50] ${asset} cancelled NO order ${state.orderIdNo}`);
      }
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
      console.error(`[B4 46/50] ${asset} cancel/sell failed after YES fill`, e);
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
        console.log(`[B4 46/50] ${asset} cancelled YES order ${state.orderIdYes}`);
      }
      const res = await createKalshiOrder({
        ticker,
        side: 'no',
        action: 'sell',
        count: fillCount,
        type: 'limit',
        no_price: SELL_PRICE,
      });
      state.sellOrderId = res.order?.order_id ?? null;
      console.log(`[B4 46/50] ${asset} NO filled ${fillCount} @46, placed sell @${SELL_PRICE}`);
    } catch (e) {
      console.error(`[B4 46/50] ${asset} cancel/sell failed after NO fill`, e);
    }
    state.done = true;
    state.orderIdYes = null;
    state.orderIdNo = null;
    return;
  }

  // Near end of window: cancel both resting orders if neither filled; log no_fill
  if (minutesLeft < 1 && (state.orderIdYes || state.orderIdNo)) {
    try {
      if (state.orderIdYes) await cancelKalshiOrder(state.orderIdYes);
      if (state.orderIdNo) await cancelKalshiOrder(state.orderIdNo);
      await logB4Paper({ window_unix: state.windowUnix, asset, event: 'no_fill', direction: null, price: null });
      console.log(`[B4 46/50] ${asset} window ending, cancelled resting orders (no fill)`);
    } catch (_) {}
    state.done = true;
    state.orderIdYes = null;
    state.orderIdNo = null;
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
  console.log('[B4 46/50] BTC + ETH, Kalshi, $1 per asset. Place 46 yes+no; on first fill cancel other, place 50 sell. Emergency off respected. Poll every', POLL_MS, 'ms');
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
