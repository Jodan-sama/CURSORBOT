/**
 * One-off: delete B5 positions with strike_spread_pct = 0 (backfilled rows with no spread).
 * Run: npx tsx src/scripts/delete-b5-zero-spread-positions.ts
 * DRY_RUN=1 to only list what would be deleted.
 */
import 'dotenv/config';
import { getDb } from '../db/supabase.js';

async function main() {
  const dryRun = process.env.DRY_RUN === '1';

  const { data: rows, error: selectError } = await getDb()
    .from('positions')
    .select('id, entered_at, asset, ticker_or_slug, strike_spread_pct, position_size, outcome')
    .eq('bot', 'B5')
    .eq('strike_spread_pct', 0);

  if (selectError) {
    console.error('Select failed:', selectError.message);
    process.exit(1);
  }

  const list = (rows ?? []) as {
    id: string;
    entered_at: string;
    asset: string;
    ticker_or_slug: string | null;
    strike_spread_pct: number;
    position_size: number;
    outcome: string | null;
  }[];
  console.log(`Found ${list.length} B5 position(s) with strike_spread_pct = 0`);

  if (list.length === 0) {
    return;
  }

  for (const r of list) {
    console.log(`  ${r.entered_at} | ${r.asset} | spread=${r.strike_spread_pct} size=${r.position_size} outcome=${r.outcome ?? 'null'}`);
  }

  if (dryRun) {
    console.log('DRY_RUN: would delete', list.length, 'row(s). Run without DRY_RUN=1 to delete.');
    return;
  }

  const { error: deleteError } = await getDb()
    .from('positions')
    .delete()
    .eq('bot', 'B5')
    .eq('strike_spread_pct', 0);

  if (deleteError) {
    console.error('Delete failed:', deleteError.message);
    process.exit(1);
  }

  console.log('Deleted', list.length, 'B5 position(s) with spread 0.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
