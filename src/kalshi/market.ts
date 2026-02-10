/**
 * Fetch market detail from Kalshi to get floor_strike (list endpoint often returns null).
 */

import type { Asset } from './ticker.js';
import { getCurrentWindowEnd } from '../clock.js';

const DEFAULT_BASE = 'https://api.trade.kalshi.com/trade-api/v2';

const SERIES_TICKER: Record<Asset, string> = {
  BTC: 'KXBTC15M',
  ETH: 'KXETH15M',
  SOL: 'KXSOL15M',
};

export interface KalshiMarket {
  ticker: string;
  floor_strike: number | null;
  yes_bid?: number;
  yes_ask?: number;
  expiration_time?: string;
  status?: string;
}

export interface GetMarketResponse {
  market: KalshiMarket & Record<string, unknown>;
}

export interface KalshiMarketListItem {
  ticker: string;
  expiration_time?: string;
  status?: string;
  [key: string]: unknown;
}

export interface ListMarketsResponse {
  markets: KalshiMarketListItem[];
  cursor?: string;
}

/** List open markets for a series (public, no auth). */
export async function listKalshiMarkets(
  seriesTicker: string,
  baseUrl: string = DEFAULT_BASE
): Promise<KalshiMarketListItem[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/markets?series_ticker=${encodeURIComponent(seriesTicker)}&status=open&limit=200`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kalshi list markets: ${res.status}`);
  const data = (await res.json()) as ListMarketsResponse;
  return data.markets ?? [];
}

/**
 * Resolve the current 15m market ticker for an asset (expiration at current window end).
 */
export async function getCurrentKalshiTicker(
  asset: Asset,
  baseUrl: string = DEFAULT_BASE,
  now: Date = new Date()
): Promise<string | null> {
  const series = SERIES_TICKER[asset];
  const markets = await listKalshiMarkets(series, baseUrl);
  const windowEnd = getCurrentWindowEnd(now);
  const targetMs = windowEnd.getTime();
  let best: KalshiMarketListItem | null = null;
  let bestDiff = Infinity;
  for (const m of markets) {
    const exp = m.expiration_time;
    if (!exp) continue;
    const expMs = new Date(exp).getTime();
    const diff = Math.abs(expMs - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = m;
    }
  }
  return best?.ticker ?? null;
}

export async function getKalshiMarket(
  ticker: string,
  baseUrl: string = DEFAULT_BASE
): Promise<KalshiMarket> {
  const url = `${baseUrl.replace(/\/$/, '')}/markets/${encodeURIComponent(ticker)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kalshi market ${ticker}: ${res.status}`);
  const data = (await res.json()) as GetMarketResponse;
  const m = data.market;
  return {
    ticker: m.ticker,
    floor_strike: m.floor_strike ?? null,
    yes_bid: m.yes_bid,
    yes_ask: m.yes_ask,
    expiration_time: m.expiration_time,
    status: m.status,
  };
}

/**
 * Kalshi response_price_units is usd_cent: yes_bid 96 = 96¢ = 96% for binary.
 * Use yes_bid directly as percent (0–100) for rule checks.
 */
export function kalshiYesBidAsPercent(yesBidCents: number): number {
  return yesBidCents; // already 0–100 scale for binary
}
