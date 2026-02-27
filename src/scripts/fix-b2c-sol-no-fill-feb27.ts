/**
 * One-off: Fix B2c SOL position Feb 27 07:40 (14:40 UTC) that shows No fill instead of Loss.
 * Order ID: 0xff5dc891e52f491423ba8904055f25e3c33a8f1082ff5dd725ac1fd50a7a8dfb
 *
 * Run on D2 (or locally with SUPABASE_*): npx tsx src/scripts/fix-b2c-sol-no-fill-feb27.ts
 *
 * Why it was no_fill: Resolver sets no_fill when getOrder fails or size_matched=0 and the
 * Data API fallback hasTradeForSlug(wallet, slug) returns false. For B123c we pass
 * POLYMARKET_FUNDER from .env.b123c; the Data API may list trades under the proxy wallet
 * (derive mode), so querying by funder can miss the trade. This script sets outcome from
 * Gamma resolution and raw.direction without relying on the Data API.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { fetchGammaEvent } from '../polymarket/gamma.js';

const ORDER_ID = '0xff5dc891e52f491423ba8904055f25e3c33a8f1082ff5dd725ac1fd50a7a8dfb';

function getOurSide(raw: Record<string, unknown> | null): 'Up' | 'Down' | null {
  const d = raw?.direction;
  if (d === 'up' || d === 'yes') return 'Up';
  if (d === 'down' || d === 'no') return 'Down';
  return null;
}

function getWinningOutcomeIndex(outcomePrices: string[]): number | null {
  if (outcomePrices.length !== 2) return null;
  const a = parseFloat(outcomePrices[0]);
  const b = parseFloat(outcomePrices[1]);
  if (a === 1 && b === 0) return 0;
  if (a === 0 && b === 1) return 1;
  return null;
}

function getWinningSide(outcomes: string[], winningIndex: number): 'Up' | 'Down' | null {
  if (winningIndex < 0 || winningIndex >= outcomes.length) return null;
  const name = outcomes[winningIndex];
  if (name === 'Up') return 'Up';
  if (name === 'Down') return 'Down';
  return null;
}

async function main() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_ANON_KEY required');
    process.exit(1);
  }

  const supabase = createClient(url, key);

  // Find by order_id (full or truncated in DB)
  const { data: rows, error } = await supabase
    .from('positions')
    .select('id, bot, ticker_or_slug, order_id, raw, outcome, resolved_at')
    .eq('venue', 'polymarket')
    .eq('bot', 'B2c')
    .ilike('order_id', '%ff5dc891e5%');

  if (error) {
    console.error('Select failed:', error.message);
    process.exit(1);
  }

  const position = (rows ?? [])[0] as
    | { id: string; bot: string; ticker_or_slug: string | null; order_id: string | null; raw: Record<string, unknown> | null; outcome: string | null; resolved_at: string | null }
    | undefined;

  if (!position) {
    console.error('Position not found for order_id containing ff5dc891e5. Try broadening the query.');
    process.exit(1);
  }

  const slug = position.ticker_or_slug?.trim();
  if (!slug) {
    console.error('Position has no ticker_or_slug');
    process.exit(1);
  }

  console.log('Found position:', { id: position.id, slug, outcome: position.outcome, order_id: position.order_id?.slice(0, 18) + '…' });

  const event = await fetchGammaEvent(slug);
  if (!event.markets?.length) {
    console.error('Gamma event has no markets for slug:', slug);
    process.exit(1);
  }

  const market = event.markets[0];
  const outcomePrices = (typeof market.outcomePrices === 'string'
    ? JSON.parse(market.outcomePrices || '[]')
    : market.outcomePrices) as string[];
  const outcomes = (typeof market.outcomes === 'string'
    ? JSON.parse(market.outcomes || '["Up","Down"]')
    : market.outcomes) as string[];

  const winningIdx = getWinningOutcomeIndex(outcomePrices);
  if (winningIdx == null) {
    console.error('Market not resolved yet (outcomePrices):', outcomePrices);
    process.exit(1);
  }

  const winningSide = getWinningSide(outcomes, winningIdx);
  const ourSide = getOurSide(position.raw ?? null);
  if (ourSide == null) {
    console.error('Missing direction in raw:', position.raw);
    process.exit(1);
  }
  if (winningSide == null) {
    console.error('Unknown winning side:', outcomes, winningIdx);
    process.exit(1);
  }

  const outcome = ourSide === winningSide ? 'win' : 'loss';
  console.log(`Gamma: winning=${winningSide}, our side=${ourSide} → outcome=${outcome}`);

  const { error: updateError } = await supabase
    .from('positions')
    .update({ outcome, resolved_at: new Date().toISOString() })
    .eq('id', position.id);

  if (updateError) {
    console.error('Update failed:', updateError.message);
    process.exit(1);
  }

  console.log(`Updated position ${position.id}: no_fill → ${outcome}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
