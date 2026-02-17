/**
 * Verify Supabase connection and show current config. Run: npx tsx src/scripts/check-supabase.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('Missing SUPABASE_URL and SUPABASE_ANON_KEY in .env');
  process.exit(1);
}

console.log('Supabase URL:', url);
console.log('Key (first 20 chars):', key.slice(0, 20) + '...');
console.log('');

const supabase = createClient(url, key);

async function check() {
  const { data: config, error: configErr } = await supabase
    .from('bot_config')
    .select('*')
    .eq('id', 'default')
    .single();

  if (configErr) {
    console.error('bot_config error:', configErr.message);
    return;
  }
  console.log('bot_config:', JSON.stringify(config, null, 2));

  const { data: thresholds, error: threshErr } = await supabase
    .from('spread_thresholds')
    .select('bot, asset, threshold_pct')
    .order('bot')
    .order('asset');

  if (threshErr) {
    console.error('spread_thresholds error:', threshErr.message);
    return;
  }
  console.log('\nspread_thresholds:');
  for (const r of thresholds || []) {
    console.log(`  ${r.bot} ${r.asset}: ${r.threshold_pct}`);
  }

  const { count } = await supabase.from('positions').select('*', { count: 'exact', head: true });
  console.log('\npositions count:', count ?? 0);
  console.log('\nSupabase connection OK.');
}

check().catch((e) => {
  console.error(e);
  process.exit(1);
});
