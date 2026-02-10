/**
 * Kalshi 15M crypto ticker format: KXBTC15M-YYMMDDHHMM-SS
 * - Series: KXBTC15M, KXETH15M, KXSOL15M
 * - YYMMDDHHMM: expiration UTC (e.g. 26FEB091445 = 2026-02-09 14:45)
 * - SS: strike in dollars, no decimals (e.g. 97000)
 */

const MONTH: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

export type Asset = 'BTC' | 'ETH' | 'SOL';

const SERIES_ASSET: Record<string, Asset> = {
  KXBTC15M: 'BTC',
  KXETH15M: 'ETH',
  KXSOL15M: 'SOL',
};

export interface ParsedTicker {
  ticker: string;
  series: string;
  asset: Asset;
  expiration: Date; // UTC
  strikeFromTicker: number; // dollars, from ticker suffix (may not match API floor_strike)
}

/**
 * Parse Kalshi 15M ticker. Returns null if format is invalid.
 */
export function parseKalshiTicker(ticker: string): ParsedTicker | null {
  const parts = ticker.split('-');
  if (parts.length !== 3) return null;

  const [series, dateStr, strikeStr] = parts;
  const asset = SERIES_ASSET[series];
  if (!asset) return null;

  // YYMMDDHHMM with month name: 26FEB091445
  const match = dateStr.match(/^(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;

  const yy = parseInt(match[1], 10);
  const monthStr = match[2];
  const dd = parseInt(match[3], 10);
  const hh = parseInt(match[4], 10);
  const min = parseInt(match[5], 10);
  const month = MONTH[monthStr];
  if (month == null) return null;
  const year = 2000 + yy;

  const expiration = new Date(Date.UTC(year, month - 1, dd, hh, min, 0, 0));
  const strikeFromTicker = parseInt(strikeStr, 10);
  if (Number.isNaN(strikeFromTicker)) return null;

  return {
    ticker,
    series,
    asset,
    expiration,
    strikeFromTicker,
  };
}

export function getAssetFromSeries(series: string): Asset | null {
  return SERIES_ASSET[series] ?? null;
}

export function getBinanceSymbol(asset: Asset): string {
  return `${asset}USDT`;
}
