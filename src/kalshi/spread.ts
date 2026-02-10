/**
 * Strike spread: |current - strike| / current * 100
 * Used for bot entry thresholds (B1/B2/B3).
 */

import type { Asset } from './ticker.js';

const BINANCE_PRICE_URL = 'https://api.binance.com/api/v3/ticker/price';

const BINANCE_SYMBOL: Record<Asset, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
};

export async function fetchBinancePrice(asset: Asset): Promise<number> {
  const symbol = BINANCE_SYMBOL[asset];
  const url = `${BINANCE_PRICE_URL}?symbol=${symbol}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance price failed: ${res.status}`);
  const data = (await res.json()) as { price: string };
  const price = parseFloat(data.price);
  if (Number.isNaN(price)) throw new Error(`Invalid Binance price: ${data.price}`);
  return price;
}

/**
 * Strike spread as a percentage: |current - strike| / current * 100
 */
export function strikeSpreadPct(currentPrice: number, strike: number): number {
  if (currentPrice <= 0) return NaN;
  return (Math.abs(currentPrice - strike) / currentPrice) * 100;
}

/**
 * Spread threshold (pct) per bot per asset. Bot enters only when current market
 * is OUTSIDE this range (spread > threshold). E.g. 0.21% → enter at 0.23%, not at 0.12%.
 */
export const BOT_SPREAD_THRESHOLD_PCT: Record<'B1' | 'B2' | 'B3', Record<Asset, number>> = {
  B1: { BTC: 0.21, ETH: 0.23, SOL: 0.27 },
  B2: { BTC: 0.57, ETH: 0.57, SOL: 0.62 },
  B3: { BTC: 1.0, ETH: 1.0, SOL: 1.0 },
};

/** True when spread is outside the bot’s threshold (i.e. market is outside the range → allow entry). */
export function isOutsideSpreadThreshold(
  bot: 'B1' | 'B2' | 'B3',
  asset: Asset,
  spreadPct: number
): boolean {
  const threshold = BOT_SPREAD_THRESHOLD_PCT[bot][asset];
  return spreadPct > threshold;
}
