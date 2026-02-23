/**
 * One-off: set ONLY the specific B4 false losses from the screenshots to outcome = 'no_fill'.
 * All other B4 losses are left unchanged. Matching is by date, time window, tier, and position_size.
 * Before updating, writes a backup to scripts/b4-false-losses-backup.json so you can restore with restore-b4-false-losses.ts.
 *
 * Run: npx tsx src/scripts/set-b4-false-losses-to-no-fill.ts
 * Or:  node dist/scripts/set-b4-false-losses-to-no-fill.js (after npm run build)
 * DRY_RUN=1 to only list what would be updated (no backup written).
 *
 * Screenshot times = dashboard (America/Denver). Converted to UTC for DB match.
 * - Feb 22: 19:13 B4-T2 323, 18:56 B4-T3 323 (false losses; Polymarket data delays)  → 02:13, 01:56 UTC next day
 * - Feb 20: 11:41 B4-T3 240, 11:33 B4-T2 240, 11:29 B4-T1 240  → 18:41, 18:33, 18:29 UTC
 * - Feb 18: 13:23 B4-T2 152, 13:08 B4-T2 152, 13:04 B4-T1 152, 12:59 B4-T1 152, 12:49 B4-T1 152  → 20:23, 20:08, 20:04, 19:59, 19:49 UTC
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { getDb } from '../db/supabase.js';

const BACKUP_PATH = join(process.cwd(), 'scripts', 'b4-false-losses-backup.json');

/** Exact false-loss slots from screenshots. timeUtc = UTC (DB stores timestamptz). Dashboard shows America/Denver so Feb 22 19:13/18:56 = Feb 23 02:13/01:56 UTC; fallback Feb 22 19:13/18:56 UTC in case DB differs. */
const FALSE_LOSS_SLOTS: { date: string; timeUtc: string; tier: string; position_size: number }[] = [
  { date: '2026-02-23', timeUtc: '02:13', tier: 'B4-T2', position_size: 323 },
  { date: '2026-02-23', timeUtc: '01:56', tier: 'B4-T3', position_size: 323 },
  { date: '2026-02-22', timeUtc: '19:13', tier: 'B4-T2', position_size: 323 },
  { date: '2026-02-22', timeUtc: '18:56', tier: 'B4-T3', position_size: 323 },
  { date: '2026-02-20', timeUtc: '18:41', tier: 'B4-T3', position_size: 240 },
  { date: '2026-02-20', timeUtc: '18:33', tier: 'B4-T2', position_size: 240 },
  { date: '2026-02-20', timeUtc: '18:29', tier: 'B4-T1', position_size: 240 },
  { date: '2026-02-18', timeUtc: '20:23', tier: 'B4-T2', position_size: 152 },
  { date: '2026-02-18', timeUtc: '20:08', tier: 'B4-T2', position_size: 152 },
  { date: '2026-02-18', timeUtc: '20:04', tier: 'B4-T1', position_size: 152 },
  { date: '2026-02-18', timeUtc: '19:59', tier: 'B4-T1', position_size: 152 },
  { date: '2026-02-18', timeUtc: '19:49', tier: 'B4-T1', position_size: 152 },
];

async function main() {
  const dryRun = process.env.DRY_RUN === '1';

  const idsToUpdate: string[] = [];
  const rowsToBackup: { id: string; outcome: string | null; resolved_at: string | null; entered_at: string; tier: string; position_size: number }[] = [];

  for (const slot of FALSE_LOSS_SLOTS) {
    const start = `${slot.date}T${slot.timeUtc}:00.000Z`;
    const end = `${slot.date}T${slot.timeUtc}:59.999Z`;

    const { data: rows, error } = await getDb()
      .from('positions')
      .select('id, entered_at, position_size, outcome, resolved_at, raw')
      .eq('bot', 'B4')
      .eq('outcome', 'loss')
      .eq('position_size', slot.position_size)
      .gte('entered_at', start)
      .lte('entered_at', end);

    if (error) throw new Error(`Select failed: ${error.message}`);

    const list = (rows ?? []) as { id: string; entered_at: string; position_size: number; outcome: string | null; resolved_at: string | null; raw: Record<string, unknown> | null }[];
    for (const row of list) {
      const tier = String((row.raw as Record<string, unknown>)?.tier ?? '');
      if (tier === slot.tier) {
        idsToUpdate.push(row.id);
        rowsToBackup.push({
          id: row.id,
          outcome: row.outcome ?? 'loss',
          resolved_at: row.resolved_at ?? null,
          entered_at: row.entered_at,
          tier,
          position_size: row.position_size,
        });
        console.log(`  Match: ${row.entered_at} | ${slot.tier} | $${row.position_size} | id=${row.id.slice(0, 8)}…`);
      }
    }
  }

  if (idsToUpdate.length === 0) {
    console.log('No matching false-loss rows found. (Check that slot times are UTC and match stored entered_at.)');
    return;
  }

  console.log(`\nTotal rows to set to no_fill: ${idsToUpdate.length} (only these; all other B4 losses are kept).`);

  if (dryRun) {
    console.log('\nDRY RUN: no updates made. Run without DRY_RUN=1 to apply.');
    return;
  }

  const backup = {
    reverted_at: new Date().toISOString(),
    rows: rowsToBackup,
  };
  writeFileSync(BACKUP_PATH, JSON.stringify(backup, null, 2), 'utf8');
  console.log(`\nBackup written to ${BACKUP_PATH}. To restore later: npx tsx src/scripts/restore-b4-false-losses.ts`);

  const { data: updated, error: updateError } = await getDb()
    .from('positions')
    .update({ outcome: 'no_fill', resolved_at: null })
    .in('id', idsToUpdate)
    .select('id');

  if (updateError) throw new Error(`Update failed: ${updateError.message}`);

  const n = Array.isArray(updated) ? updated.length : 0;
  console.log(`\nUpdated ${n} row(s) to outcome=no_fill. Other B4 losses unchanged.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
