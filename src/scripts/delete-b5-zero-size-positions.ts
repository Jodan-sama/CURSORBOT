/**
 * One-off: delete B5 positions with position_size 0 or very small (< 1 USD, bad backfill).
 * Run: npx tsx src/scripts/delete-b5-zero-size-positions.ts
 * DRY_RUN=1 to only list what would be deleted.
 */
import 'dotenv/config';
import { getDb } from '../db/supabase.js';

const MIN_VALID_SIZE = 1; // delete where position_size < this (0 or tiny backfill errors)

async function main() {
  const dryRun = process.env.DRY_RUN === '1';

  const { data: rows, error: selectError } = await getDb()
    .from('positions')
    .select('id, entered_at, asset, ticker_or_slug, position_size, outcome')
    .eq('bot', 'B5')
    .lt('position_size', MIN_VALID_SIZE);

  if (selectError) {
    console.error('Select failed:', selectError.message);
    process.exit(1);
  }

  const list = (rows ?? []) as { id: string; entered_at: string; asset: string; ticker_or_slug: string | null; position_size: number; outcome: string | null }[];
  console.log(`Found ${list.length} B5 position(s) with position_size < ${MIN_VALID_SIZE}`);

  if (list.length === 0) {
    return;
  }

  for (const r of list) {
    console.log(`  ${r.entered_at} | ${r.asset} | ${r.ticker_or_slug ?? ''} | size=${r.position_size} outcome=${r.outcome ?? 'null'}`);
  }

  if (dryRun) {
    console.log('DRY_RUN: would delete', list.length, 'row(s). Run without DRY_RUN=1 to delete.');
    return;
  }

  const { error: deleteError } = await getDb()
    .from('positions')
    .delete()
    .eq('bot', 'B5')
    .lt('position_size', MIN_VALID_SIZE);

  if (deleteError) {
    console.error('Delete failed:', deleteError.message);
    process.exit(1);
  }

  console.log('Deleted', list.length, 'B5 position(s) with position_size <', MIN_VALID_SIZE);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
