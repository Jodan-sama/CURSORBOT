/**
 * Strike spread: |current - strike| / current * 100
 * Used for bot entry thresholds (B1/B2/B3).
 * Current price: Binance first; if Binance returns 451 (geo-block) or fails, fall back to CoinGecko.
 */

import type { Asset } from './ticker.js';

const BINANCE_PRICE_URL = 'https://api.binance.com/api/v3/ticker/price';

const BINANCE_SYMBOL: Record<Asset, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
};

const COINGECKO_IDS: Record<Asset, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
};

/** Binance spot price only; throws on 451/geo-block or other errors. */
export async function fetchBinancePriceOnly(asset: Asset): Promise<number> {
  const symbol = BINANCE_SYMBOL[asset];
  const url = `${BINANCE_PRICE_URL}?symbol=${symbol}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance price failed: ${res.status}`);
  const data = (await res.json()) as { price: string };
  const price = parseFloat(data.price);
  if (Number.isNaN(price)) throw new Error(`Invalid Binance price: ${data.price}`);
  return price;
}

/** CoinGecko spot price only (one asset, one request). */
export async function fetchCoinGeckoPrice(asset: Asset): Promise<number> {
  const id = COINGECKO_IDS[asset];
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko price failed: ${res.status}`);
  const data = (await res.json()) as { [id: string]: { usd: number } };
  const price = data[id]?.usd;
  if (price == null || Number.isNaN(price)) throw new Error(`Invalid CoinGecko price for ${asset}`);
  return price;
}

/** CoinGecko prices for BTC, ETH, SOL in one request (avoids rate limit in scripts). */
export async function fetchCoinGeckoPricesAll(): Promise<Record<Asset, number>> {
  const ids = ['bitcoin', 'ethereum', 'solana'].join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko price failed: ${res.status}`);
  const data = (await res.json()) as { bitcoin?: { usd: number }; ethereum?: { usd: number }; solana?: { usd: number } };
  return {
    BTC: data.bitcoin?.usd ?? NaN,
    ETH: data.ethereum?.usd ?? NaN,
    SOL: data.solana?.usd ?? NaN,
  };
}

/** Fetches current spot price. Always prefers Binance (more accurate); only uses CoinGecko when Binance is unavailable (e.g. 451 geo-block). */
export async function fetchBinancePrice(asset: Asset): Promise<number> {
  try {
    return await fetchBinancePriceOnly(asset);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('451') || msg.includes('Binance')) {
      try {
        return await fetchCoinGeckoPrice(asset);
      } catch (e2) {
        throw new Error(`Price fetch failed (Binance: ${msg}; CoinGecko: ${e2 instanceof Error ? e2.message : e2})`);
      }
    }
    throw e;
  }
}

/**
 * Strike spread as a percentage (magnitude): |current - strike| / current * 100
 */
export function strikeSpreadPct(currentPrice: number, strike: number): number {
  if (currentPrice <= 0) return NaN;
  return (Math.abs(currentPrice - strike) / currentPrice) * 100;
}

/**
 * Signed spread %: (current - strike) / current * 100.
 * Positive = price above strike (Yes side). Negative = price below strike (No side).
 * We only place when |signedSpread| > threshold; side = sign(signedSpread).
 */
export function strikeSpreadPctSigned(currentPrice: number, strike: number): number {
  if (currentPrice <= 0) return NaN;
  return ((currentPrice - strike) / currentPrice) * 100;
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

/** Matrix of spread thresholds (pct) per bot per asset. Used by runner when reading from DB. */
export type SpreadThresholdsMatrix = Record<'B1' | 'B2' | 'B3', Record<Asset, number>>;

/** True when spread is outside the bot’s threshold (i.e. market is outside the range → allow entry). */
export function isOutsideSpreadThreshold(
  bot: 'B1' | 'B2' | 'B3',
  asset: Asset,
  spreadPct: number,
  thresholds?: SpreadThresholdsMatrix
): boolean {
  const threshold = thresholds ? thresholds[bot][asset] : BOT_SPREAD_THRESHOLD_PCT[bot][asset];
  return spreadPct > threshold;
}
