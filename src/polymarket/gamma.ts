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
};

/**
 * Fetch event by slug. Returns full Gamma event.
 */
export async function fetchGammaEvent(slug: string): Promise<GammaEvent> {
  const url = `${GAMMA_BASE}/events/slug/${encodeURIComponent(slug)}`;
  const res = await fetch(url);
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
