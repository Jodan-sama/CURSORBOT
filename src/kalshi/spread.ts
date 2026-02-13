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
  XRP: 'XRPUSDT',
};

const COINGECKO_IDS: Record<Asset, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  XRP: 'ripple',
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

/** CoinGecko prices for BTC, ETH, SOL, XRP in one request (avoids rate limit in scripts). */
export async function fetchCoinGeckoPricesAll(): Promise<Record<Asset, number>> {
  const ids = ['bitcoin', 'ethereum', 'solana', 'ripple'].join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko price failed: ${res.status}`);
  const data = (await res.json()) as { bitcoin?: { usd: number }; ethereum?: { usd: number }; solana?: { usd: number }; ripple?: { usd: number } };
  return {
    BTC: data.bitcoin?.usd ?? NaN,
    ETH: data.ethereum?.usd ?? NaN,
    SOL: data.solana?.usd ?? NaN,
    XRP: data.ripple?.usd ?? NaN,
  };
}

const PRICE_RETRY_DELAY_MS = 1500;

/** Fetches current spot price. Prefers Binance (with one retry); falls back to CoinGecko on failure. */
export async function fetchBinancePrice(asset: Asset): Promise<number> {
  try {
    return await fetchBinancePriceOnly(asset);
  } catch (e) {
    try {
      await new Promise((r) => setTimeout(r, PRICE_RETRY_DELAY_MS));
      return await fetchBinancePriceOnly(asset);
    } catch {
      try {
        return await fetchCoinGeckoPrice(asset);
      } catch (e2) {
        const msg = e instanceof Error ? e.message : String(e);
        const msg2 = e2 instanceof Error ? e2.message : String(e2);
        throw new Error(`Price fetch failed (Binance: ${msg}; CoinGecko: ${msg2})`);
      }
    }
  }
}

const ASSETS: Asset[] = ['BTC', 'ETH', 'SOL', 'XRP'];

export type PriceSource = 'binance' | 'coingecko';

export interface FetchPricesResult {
  prices: Record<Asset, number>;
  priceSource: Record<Asset, PriceSource>;
}

/**
 * Fetches prices for all assets in one tick. Uses Binance sequentially (avoids burst);
 * each gets one retry. On any failure, falls back to single CoinGecko batch (avoids 429).
 */
export async function fetchAllPricesOnce(): Promise<FetchPricesResult> {
  const byAsset: Partial<Record<Asset, number>> = {};
  const priceSource: Record<Asset, PriceSource> = { BTC: 'binance', ETH: 'binance', SOL: 'binance', XRP: 'binance' };
  const binanceFailed: Asset[] = [];
  for (const a of ASSETS) {
    try {
      const price = await fetchBinancePriceOnly(a);
      if (!Number.isNaN(price)) byAsset[a] = price;
    } catch {
      try {
        await new Promise((r) => setTimeout(r, PRICE_RETRY_DELAY_MS));
        const price = await fetchBinancePriceOnly(a);
        if (!Number.isNaN(price)) byAsset[a] = price;
      } catch {
        binanceFailed.push(a);
      }
    }
  }
  if (Object.keys(byAsset).length === ASSETS.length) {
    return { prices: byAsset as Record<Asset, number>, priceSource };
  }
  try {
    const cg = await fetchCoinGeckoPricesAll();
    console.log(`[price] CoinGecko fallback (Binance failed: ${binanceFailed.join(', ')})`);
    for (const a of binanceFailed) priceSource[a] = 'coingecko';
    return {
      prices: {
        BTC: byAsset.BTC ?? cg.BTC,
        ETH: byAsset.ETH ?? cg.ETH,
        SOL: byAsset.SOL ?? cg.SOL,
        XRP: byAsset.XRP ?? cg.XRP,
      },
      priceSource,
    };
  } catch (e) {
    const cgMsg = e instanceof Error ? e.message : String(e);
    const binanceCtx = binanceFailed.length > 0 ? `Binance failed for: ${binanceFailed.join(', ')}; ` : '';
    throw new Error(`Price fetch failed: ${binanceCtx}CoinGecko fallback: ${cgMsg}`);
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
  B1: { BTC: 0.21, ETH: 0.23, SOL: 0.27, XRP: 0.27 },
  B2: { BTC: 0.57, ETH: 0.57, SOL: 0.62, XRP: 0.62 },
  B3: { BTC: 1.0, ETH: 1.0, SOL: 1.0, XRP: 1.0 },
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
