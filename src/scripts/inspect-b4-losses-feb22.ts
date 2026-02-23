/**
 * Inspect the two B4 "false loss" positions (Feb 22 19:13 B4-T2, 18:56 B4-T3, size 323).
 * Prints what we have in DB and what Polymarket getOrder returns (size_matched = filled or not).
 *
 * Run: npx tsx src/scripts/inspect-b4-losses-feb22.ts
 * Needs: SUPABASE_URL, SUPABASE_ANON_KEY (or service key), and B4 Poly env (POLYMARKET_*) for getOrder.
 */
import 'dotenv/config';
import { getDb } from '../db/supabase.js';
import { getOrCreateDerivedPolyClient } from '../polymarket/clob.js';

const POSITION_SIZE = 323;
const TIERS = ['B4-T2', 'B4-T3'];

// Time windows (UTC): dashboard shows Feb 22 19:13 / 18:56 America/Denver = Feb 23 02:13 / 01:56 UTC; also try Feb 22 19:13 / 18:56 UTC
const WINDOWS: { start: string; end: string; label: string }[] = [
  { start: '2026-02-23T01:55:00.000Z', end: '2026-02-23T02:15:00.000Z', label: 'Feb 23 01:56–02:13 UTC (Denver 18:56–19:13)' },
  { start: '2026-02-22T18:55:00.000Z', end: '2026-02-22T19:15:00.000Z', label: 'Feb 22 18:56–19:13 UTC' },
];

async function main() {
  const { data: rows, error } = await getDb()
    .from('positions')
    .select('id, entered_at, order_id, position_size, outcome, resolved_at, ticker_or_slug, raw')
    .eq('bot', 'B4')
    .eq('outcome', 'loss')
    .eq('position_size', POSITION_SIZE)
    .order('entered_at', { ascending: true });

  if (error) {
    console.error('DB error:', error.message);
    process.exit(1);
  }

  const list = (rows ?? []) as {
    id: string;
    entered_at: string;
    order_id: string | null;
    position_size: number;
    outcome: string | null;
    resolved_at: string | null;
    ticker_or_slug: string | null;
    raw: Record<string, unknown> | null;
  }[];

  const inWindow = list.filter((r) => {
    const t = new Date(r.entered_at).getTime();
    for (const w of WINDOWS) {
      if (t >= new Date(w.start).getTime() && t <= new Date(w.end).getTime()) return true;
    }
    return false;
  });

  const byTier = inWindow.filter((r) => {
    const tier = String((r.raw as Record<string, unknown>)?.tier ?? '');
    return TIERS.includes(tier);
  });

  console.log('B4 positions (loss, size 323) in Feb 22/23 window:\n');
  if (byTier.length === 0) {
    console.log('No matching rows. All B4 loss rows with position_size 323:');
    list.forEach((r) => {
      const tier = String((r.raw as Record<string, unknown>)?.tier ?? '');
      console.log(`  ${r.entered_at} | ${tier} | $${r.position_size} | order_id=${r.order_id ? r.order_id.slice(0, 16) + '…' : 'null'} | id=${r.id.slice(0, 8)}…`);
    });
    return;
  }

  let clob: Awaited<ReturnType<typeof getOrCreateDerivedPolyClient>> | null = null;
  try {
    clob = await getOrCreateDerivedPolyClient();
  } catch (e) {
    console.warn('B4 CLOB client not available (missing POLYMARKET_* env). Will show DB only:', e instanceof Error ? e.message : e);
  }

  for (const row of byTier) {
    const tier = String((row.raw as Record<string, unknown>)?.tier ?? '');
    console.log('---');
    console.log('DB:', {
      id: row.id.slice(0, 8) + '…',
      entered_at: row.entered_at,
      tier,
      slug: row.ticker_or_slug,
      order_id: row.order_id ?? '(none)',
      outcome: row.outcome,
      resolved_at: row.resolved_at ?? '(null)',
    });

    if (!row.order_id?.trim()) {
      console.log('Polymarket: no order_id — we never recorded a placed order for this row.');
      continue;
    }

    if (!clob) continue;

    try {
      const order = await clob.getOrder(row.order_id.trim());
      const sizeMatched = order?.size_matched;
      const filled = sizeMatched != null && parseFloat(String(sizeMatched)) > 0;
      console.log('Polymarket getOrder:', {
        order_id: row.order_id.slice(0, 20) + '…',
        size_matched: sizeMatched ?? '(missing)',
        filled: filled ? 'YES' : 'NO',
        status: order != null && typeof order === 'object' && 'status' in order ? String((order as unknown as { status?: unknown }).status) : '(unknown)',
      });
      if (!filled) {
        console.log('  → Order was NOT filled (size_matched 0 or missing). Resolver should have set outcome=no_fill.');
      }
    } catch (e) {
      console.log('Polymarket getOrder error:', e instanceof Error ? e.message : e);
    }
  }
  console.log('---');
  console.log(`Total rows inspected: ${byTier.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
