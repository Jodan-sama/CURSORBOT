/**
 * One-off: clear B4 early-guard cooldown in Supabase so B4 can run again.
 * Run: node dist/scripts/clear-b4-early-guard.js (after npm run build)
 * Then restart: systemctl restart cursorbot-b4-5m
 */
import 'dotenv/config';
import { updateB4EarlyGuard } from '../db/supabase.js';

async function main() {
  await updateB4EarlyGuard(0);
  console.log('B4 early-guard cooldown cleared in Supabase. Restart cursorbot-b4-5m to apply.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
