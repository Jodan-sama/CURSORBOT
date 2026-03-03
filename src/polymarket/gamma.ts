/**
 * Polymarket Gamma API – fetch event by slug and parse market data for CLOB.
 */

import type { Asset } from '../kalshi/ticker.js';
import type { GammaEvent, ParsedPolyMarket } from './types.js';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

/** Slug prefix per asset for 15M up/down markets. */
export const POLY_15M_SLUG_PREFIX: Record<Asset, string> = {
  BTC: 'btc-updown-15m-',
  ETH: 'eth-updown-15m-',
  SOL: 'sol-updown-15m-',
  XRP: 'xrp-updown-15m-',
};

/**
 * Get CLOB token ID for the given outcome in an Up/Down (or Yes/No) market.
 * Uses outcome name so we don't rely on Gamma's array order (which can differ by market).
 * - wantUp: true → token for "Up" (or "Yes"); false → token for "Down" (or "No").
 * Returns tokenId or null if outcome not found.
 */
export function getTokenIdForOutcome(market: ParsedPolyMarket, wantUp: boolean): string | null {
  const target = wantUp ? 'Up' : 'Down';
  const fallback = wantUp ? 'Yes' : 'No';
  const idx = market.outcomes.findIndex(
    (o) => o.toLowerCase() === target.toLowerCase() || o.toLowerCase() === fallback.toLowerCase()
  );
  if (idx >= 0 && market.clobTokenIds[idx]) return market.clobTokenIds[idx];
  // Legacy: assume outcomes order [Up/Yes, Down/No] → index 0 = first, 1 = second
  const legacyIdx = wantUp ? 0 : 1;
  return market.clobTokenIds[legacyIdx] ?? null;
}

/**
 * Fetch event by slug. Returns full Gamma event.
 * Uses cache-busting and no-cache headers so each call gets a fresh response (Gamma can still
 * update outcomePrices on their backend with ~1s+ delay; for true real-time use CLOB WebSocket).
 */
export async function fetchGammaEvent(slug: string): Promise<GammaEvent> {
  const url = `${GAMMA_BASE}/events/slug/${encodeURIComponent(slug)}?t=${Date.now()}`;
  const res = await fetch(url, {
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Gamma event ${slug}: ${res.status}`);
  return (await res.json()) as GammaEvent;
}

/**
 * Parse outcomePrices and clobTokenIds from first market (they are JSON strings).
 */
export function parseGammaMarket(market: GammaEvent['markets'][0]): ParsedPolyMarket {
  const outcomePrices = JSON.parse(market.outcomePrices || '[]') as string[];
  const clobTokenIds = JSON.parse(market.clobTokenIds || '[]') as string[];
  const outcomes = (market.outcomes ? JSON.parse(market.outcomes) : ['Yes', 'No']) as string[];
  return {
    conditionId: market.conditionId,
    slug: market.slug,
    outcomePrices: outcomePrices.map((p) => parseFloat(p)),
    clobTokenIds,
    outcomes,
    orderMinSize: market.orderMinSize,
    orderPriceMinTickSize: market.orderPriceMinTickSize,
    negRisk: market.negRisk,
    endDate: market.endDate ?? market.endDateIso,
  };
}

/**
 * Fetch event by slug and return parsed primary market (first market).
 */
export async function getPolyMarketBySlug(slug: string): Promise<ParsedPolyMarket> {
  const event = await fetchGammaEvent(slug);
  if (!event.markets?.length) throw new Error(`Gamma event ${slug}: no markets`);
  return parseGammaMarket(event.markets[0]);
}

/**
 * Build slug for 15M market: {asset}-updown-15m-{unixTimestampEnd}.
 * timestampEnd should be the end of the 15m window (e.g. 14:45 UTC = 1770671700 for that window).
 */
export function poly15mSlug(asset: Asset, timestampEndSeconds: number): string {
  const prefix = POLY_15M_SLUG_PREFIX[asset];
  return `${prefix}${timestampEndSeconds}`;
}

/** Raw market from Gamma GET /markets (list). */
export interface GammaMarketRow {
  id?: string;
  question?: string;
  conditionId?: string;
  slug?: string;
  outcomePrices?: string;
  clobTokenIds?: string;
  outcomes?: string;
  orderPriceMinTickSize?: number;
  orderMinSize?: number;
  negRisk?: boolean;
  closed?: boolean;
  [key: string]: unknown;
}

/**
 * Fetch active markets from Gamma (for B5 basket discovery).
 * GET /markets?closed=false&limit=500
 */
export async function listGammaMarkets(closed = false, limit = 500): Promise<GammaMarketRow[]> {
  const url = `${GAMMA_BASE}/markets?closed=${String(closed)}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma list markets: ${res.status}`);
  return (await res.json()) as GammaMarketRow[];
}
