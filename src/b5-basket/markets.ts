/**
 * B5: Discover 5m and 15m BTC/ETH direction markets from Gamma.
 */

import { listGammaMarkets, parseGammaMarket, type GammaMarketRow } from '../polymarket/gamma.js';
import type { GammaMarket, ParsedPolyMarket } from '../polymarket/types.js';

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

function parseOutcomePrices(raw: string | undefined): number[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as string[] | number[];
    return arr.map((x) => (typeof x === 'string' ? parseFloat(x) : x));
  } catch {
    return [];
  }
}

function parseClobTokenIds(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as string[];
    return arr.map((x) => String(x).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Filter and parse markets for 5m/15m BTC/ETH up-or-down. */
export async function discoverB5Markets(): Promise<B5Candidate[]> {
  const rows = await listGammaMarkets(false, 500);
  const candidates: B5Candidate[] = [];

  for (const m of rows) {
    const q = (m.question ?? '').toLowerCase();
    if (!/(bitcoin|btc|eth|ether)/i.test(q)) continue;
    if (!/(5\s*min|15\s*min|5\s*minute|15\s*minute|up\s*or\s*down)/i.test(q)) continue;

    const prices = parseOutcomePrices(m.outcomePrices);
    const tokenIds = parseClobTokenIds(m.clobTokenIds);
    if (tokenIds.length === 0 || prices.length === 0) continue;

    const timeframe = /5\s*min|5\s*minute/.test(q) ? '5min' : '15min';

    for (let i = 0; i < prices.length && i < tokenIds.length; i++) {
      const price = typeof prices[i] === 'number' ? prices[i] : parseFloat(String(prices[i]));
      if (Number.isNaN(price) || price <= 0) continue;
      candidates.push({
        tokenId: tokenIds[i],
        price,
        estP: 0.5, // filled by edge engine
        edge: 0,
        question: m.question ?? '',
        timeframe,
        slug: m.slug ?? '',
        market: parseGammaMarket(m as GammaMarket),
        outcomeIndex: i,
      });
    }
  }

  return candidates;
}
