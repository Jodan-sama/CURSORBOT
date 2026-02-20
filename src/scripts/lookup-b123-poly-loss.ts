/**
 * One-off: find B1/B2/B3 Polymarket loss in 12:15–12:30 ET window.
 * Run: npx tsx src/scripts/lookup-b123-poly-loss.ts
 * Or on D2: node dist/scripts/lookup-b123-poly-loss.js (needs SUPABASE_* in env)
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

async function main() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
    process.exit(1);
  }
  const supabase = createClient(url, key);

  // 12:15–12:30 ET → EST 17:15–17:30 UTC, EDT 16:15–16:30 UTC. Query both days to be safe.
  const ranges = [
    { start: '2026-02-20T17:15:00.000Z', end: '2026-02-20T17:30:00.000Z', label: '2026-02-20 12:15–12:30 ET (EST)' },
    { start: '2026-02-20T16:15:00.000Z', end: '2026-02-20T16:30:00.000Z', label: '2026-02-20 12:15–12:30 ET (EDT)' },
    { start: '2026-02-21T17:15:00.000Z', end: '2026-02-21T17:30:00.000Z', label: '2026-02-21 12:15–12:30 ET (EST)' },
    { start: '2026-02-21T16:15:00.000Z', end: '2026-02-21T16:30:00.000Z', label: '2026-02-21 12:15–12:30 ET (EDT)' },
  ];

  for (const { start, end, label } of ranges) {
      const { data, error } = await supabase
        .from('positions')
        .select('id, entered_at, bot, asset, venue, strike_spread_pct, position_size, outcome, ticker_or_slug, raw')
        .in('bot', ['B1', 'B2', 'B3'])
        .eq('venue', 'polymarket')
        .eq('outcome', 'loss')
        .gte('entered_at', start)
        .lte('entered_at', end)
        .order('entered_at', { ascending: true });

      if (error) {
        console.error('Query error:', error.message);
        continue;
      }
      const rows = data ?? [];
      if (rows.length > 0) {
        console.log(`\n=== ${label} ===`);
        for (const r of rows) {
          console.log({
            id: r.id,
            entered_at: r.entered_at,
            bot: r.bot,
            asset: r.asset,
            strike_spread_pct: r.strike_spread_pct,
            position_size: r.position_size,
            outcome: r.outcome,
            ticker_or_slug: r.ticker_or_slug,
          });
          if (r.strike_spread_pct != null) {
            console.log(`  -> Entry spread %: ${r.strike_spread_pct}`);
          }
        }
      }
  }
  // Also list any B123 Poly loss in last 24h in case the timezone was off
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recent, error: e2 } = await supabase
    .from('positions')
    .select('id, entered_at, bot, asset, strike_spread_pct, position_size, outcome, ticker_or_slug')
    .in('bot', ['B1', 'B2', 'B3'])
    .eq('venue', 'polymarket')
    .eq('outcome', 'loss')
    .gte('entered_at', dayAgo)
    .order('entered_at', { ascending: false })
    .limit(20);
  if (e2) {
    console.error('Recent query error:', e2.message);
    return;
  }
  if ((recent ?? []).length > 0) {
    console.log('\n=== B1/B2/B3 Poly losses (last 24h) ===');
    for (const r of recent ?? []) {
      console.log(`${r.entered_at} | ${r.bot} ${r.asset} | spread ${r.strike_spread_pct}% | ${r.outcome}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
