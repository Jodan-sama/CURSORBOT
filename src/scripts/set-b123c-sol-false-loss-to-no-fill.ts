/**
 * One-off: set exactly ONE row — the B1c SOL false loss (wrong-side "Up 4c", slug sol-updown-15m-1772496000)
 * — to outcome = 'no_fill'. No other rows or code are touched.
 *
 * Run on D2: cd /root/cursorbot && npx tsx src/scripts/set-b123c-sol-false-loss-to-no-fill.ts
 * DRY_RUN=1 to only print the one row that would be updated (no DB change).
 */
import 'dotenv/config';
import { getDb } from '../db/supabase.js';

const SLUG = 'sol-updown-15m-1772496000';

async function main() {
  const dryRun = process.env.DRY_RUN === '1';

  const { data: rows, error } = await getDb()
    .from('positions')
    .select('id, entered_at, bot, ticker_or_slug, outcome, position_size, strike_spread_pct')
    .eq('bot', 'B1c')
    .eq('outcome', 'loss')
    .eq('ticker_or_slug', SLUG)
    .order('entered_at', { ascending: false })
    .limit(1);

  if (error) throw new Error(`Select failed: ${error.message}`);

  const list = (rows ?? []) as { id: string; entered_at: string; bot: string; ticker_or_slug: string; outcome: string; position_size: number; strike_spread_pct: number }[];

  if (list.length === 0) {
    console.log(`No B1c loss row found for slug ${SLUG}. Nothing to do.`);
    return;
  }

  const row = list[0];
  console.log(`Single row to update: ${row.entered_at} | ${row.bot} | ${row.ticker_or_slug} | spread=${row.strike_spread_pct} | size=${row.position_size} | id=${row.id.slice(0, 8)}…`);

  if (dryRun) {
    console.log('\nDRY RUN: no update. Run without DRY_RUN=1 to update this one row only.');
    return;
  }

  const { error: updateError } = await getDb()
    .from('positions')
    .update({ outcome: 'no_fill', resolved_at: new Date().toISOString() })
    .eq('id', row.id);

  if (updateError) throw new Error(`Update failed: ${updateError.message}`);

  console.log(`\nUpdated 1 row (id=${row.id.slice(0, 8)}…) to outcome=no_fill. No other rows touched.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
