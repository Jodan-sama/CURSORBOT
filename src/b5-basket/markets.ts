/**
 * B5: Discover 5m and 15m BTC/ETH markets by slug (same as B4 and B1/B123c).
 * Always finds current 5m BTC and 15m BTC/ETH markets via clock-derived slugs.
 */

import { getPolySlug5m } from '../b4-5m/clock.js';
import { getCurrentPolySlug } from '../clock.js';
import { getPolyMarketBySlug } from '../polymarket/gamma.js';
import type { ParsedPolyMarket } from '../polymarket/types.js';
import type { Asset } from '../kalshi/ticker.js';

export interface B5Candidate {
  tokenId: string;
  price: number;
  estP: number;
  edge: number;
  question: string;
  timeframe: '5min' | '15min';
  slug: string;
  market: ParsedPolyMarket;
  outcomeIndex: number;
}

/** Slugs for current 5m BTC and 15m BTC/ETH (same logic as B4 and B1). */
export function getB5Slugs(now: Date = new Date()): { slug: string; timeframe: '5min' | '15min'; asset: 'BTC' | 'ETH' }[] {
  return [
    { slug: getPolySlug5m(now), timeframe: '5min', asset: 'BTC' },
    { slug: getCurrentPolySlug('BTC' as Asset, now), timeframe: '15min', asset: 'BTC' },
    { slug: getCurrentPolySlug('ETH' as Asset, now), timeframe: '15min', asset: 'ETH' },
  ];
}

/**
 * Fetch markets by slug (call from inside withPolyProxy so Gamma uses proxy).
 * If returnAllOutcomes is true, returns every outcome (0 < price < 1) for edge logging.
 * Otherwise returns only outcomes with price < cheapThreshold (basket candidates).
 */
export async function discoverB5MarketsBySlug(
  now: Date,
  cheapThreshold: number,
  returnAllOutcomes = false
): Promise<B5Candidate[]> {
  const slugs = getB5Slugs(now);
  const candidates: B5Candidate[] = [];

  for (const { slug, timeframe, asset } of slugs) {
    let market: ParsedPolyMarket;
    try {
      market = await getPolyMarketBySlug(slug);
    } catch (e) {
      console.warn(`[B5] Market fetch failed: ${slug}`, e instanceof Error ? e.message : e);
      continue;
    }
    console.log(`[B5] Fetched ${asset} ${timeframe}: ${slug} prices=${(market.outcomePrices ?? []).join(',')}`);
    const prices = market.outcomePrices ?? [];
    const tokenIds = market.clobTokenIds ?? [];
    const outcomes = market.outcomes ?? ['Yes', 'No'];
    for (let i = 0; i < prices.length && i < tokenIds.length; i++) {
      const price = prices[i];
      if (price <= 0 || price >= 1) continue;
      if (!returnAllOutcomes && price >= cheapThreshold) continue;
      const direction = i === 0 ? 'up' : 'down';
      const question = `${asset} ${timeframe} ${direction}`;
      candidates.push({
        tokenId: tokenIds[i],
        price,
        estP: 0.5,
        edge: 0,
        question,
        timeframe,
        slug,
        market,
        outcomeIndex: i,
      });
    }
  }

  return candidates;
}
