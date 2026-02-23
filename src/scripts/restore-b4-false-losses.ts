/**
 * Restore B4 positions from a backup created by set-b4-false-losses-to-no-fill.ts.
 * Reads scripts/b4-false-losses-backup.json and sets outcome + resolved_at back for each id.
 *
 * Run: npx tsx src/scripts/restore-b4-false-losses.ts
 * Or:  node dist/scripts/restore-b4-false-losses.js (after npm run build)
 * DRY_RUN=1 to only list what would be restored (no updates).
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getDb } from '../db/supabase.js';

const BACKUP_PATH = join(process.cwd(), 'scripts', 'b4-false-losses-backup.json');

type BackupRow = { id: string; outcome: string | null; resolved_at: string | null; entered_at: string; tier: string; position_size: number };
type Backup = { reverted_at: string; rows: BackupRow[] };

async function main() {
  const dryRun = process.env.DRY_RUN === '1';

  if (!existsSync(BACKUP_PATH)) {
    console.error(`Backup not found: ${BACKUP_PATH}`);
    console.error('Run set-b4-false-losses-to-no-fill.ts first to create the backup.');
    process.exit(1);
  }

  const backup: Backup = JSON.parse(readFileSync(BACKUP_PATH, 'utf8'));
  const rows = backup.rows ?? [];
  if (rows.length === 0) {
    console.log('Backup has no rows to restore.');
    return;
  }

  console.log(`Backup from ${backup.reverted_at}; ${rows.length} row(s) to restore.`);
  for (const r of rows) {
    console.log(`  ${r.entered_at} | ${r.tier} | $${r.position_size} | id=${r.id.slice(0, 8)}… → outcome=${r.outcome}, resolved_at=${r.resolved_at ?? 'null'}`);
  }

  if (dryRun) {
    console.log('\nDRY RUN: no updates made. Run without DRY_RUN=1 to restore.');
    return;
  }

  let restored = 0;
  for (const row of rows) {
    const { error } = await getDb()
      .from('positions')
      .update({
        outcome: row.outcome ?? 'loss',
        resolved_at: row.resolved_at,
      })
      .eq('id', row.id);

    if (error) {
      console.error(`Update ${row.id.slice(0, 8)}… failed:`, error.message);
      continue;
    }
    restored++;
    console.log(`  Restored id=${row.id.slice(0, 8)}…`);
  }

  console.log(`\nRestored ${restored} row(s). Backup file unchanged (delete or keep for re-run).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
