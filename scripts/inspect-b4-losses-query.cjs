// One-off: run on D2 with: node scripts/inspect-b4-losses-query.cjs
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
  process.exit(1);
}

const db = createClient(url, key);

async function main() {
  const { data, error } = await db
    .from('positions')
    .select('id, entered_at, order_id, position_size, outcome, resolved_at, ticker_or_slug, raw')
    .eq('bot', 'B4')
    .eq('outcome', 'loss')
    .eq('position_size', 323)
    .order('entered_at', { ascending: true });

  if (error) {
    console.error('DB error:', error.message);
    process.exit(1);
  }

  console.log('B4 positions (outcome=loss, position_size=323):');
  console.log(JSON.stringify(data, null, 2));

  const feb22 = (data || []).filter((r) => {
    const t = r.entered_at;
    return (
      (t && t.startsWith('2026-02-22')) ||
      (t && t.startsWith('2026-02-23') && (t.includes('01:') || t.includes('02:')))
    );
  });

  console.log('\nIn Feb 22/23 window:', feb22.length);
  feb22.forEach((r) => {
    const tier = (r.raw && r.raw.tier) || '';
    console.log('  ', r.entered_at, tier, 'order_id=' + (r.order_id ? r.order_id.slice(0, 24) + '...' : 'null'));
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
