/**
 * One-off: Re-resolve Kalshi positions that are outcome = 'loss' or 'no_fill' in case they were mislabeled.
 * Re-fetches order (fill_count) and settlements, recomputes outcome, and updates if different.
 * Run on D1 (Kalshi credentials): npx tsx src/scripts/re-resolve-kalshi-outcomes.ts [days=30]
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { getKalshiOrder } from '../kalshi/orders.js';
import { getKalshiSettlements, type KalshiSettlement } from '../kalshi/settlements.js';

function settlementMap(settlements: KalshiSettlement[]): Map<string, KalshiSettlement> {
  const map = new Map<string, KalshiSettlement>();
  for (const s of settlements) {
    const existing = map.get(s.ticker);
    if (!existing || new Date(s.settled_time).getTime() > new Date(existing.settled_time).getTime()) {
      map.set(s.ticker, s);
    }
  }
  return map;
}

async function main() {
  const days = Math.max(1, parseInt(process.argv[2] ?? '30', 10));
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
    process.exit(1);
  }
  const supabase = createClient(url, key);

  const { data: rows, error } = await supabase
    .from('positions')
    .select('id, bot, ticker_or_slug, order_id, outcome')
    .eq('venue', 'kalshi')
    .in('bot', ['B1', 'B2', 'B3'])
    .in('outcome', ['loss', 'no_fill'])
    .gte('entered_at', since);

  if (error) {
    console.error('Select failed:', error.message);
    process.exit(1);
  }
  const positions = (rows ?? []) as { id: string; bot: string; ticker_or_slug: string | null; order_id: string | null; outcome: string }[];
  console.log(`Found ${positions.length} Kalshi loss/no_fill positions in last ${days} days.`);

  const minTs = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
  const allSettlements: KalshiSettlement[] = [];
  let cursor: string | undefined;
  do {
    const res = await getKalshiSettlements({ min_ts: minTs, limit: 200, cursor });
    allSettlements.push(...(res.settlements ?? []));
    cursor = res.cursor;
  } while (cursor);
  const byTicker = settlementMap(allSettlements);

  let updated = 0;
  for (const row of positions) {
    const ticker = row.ticker_or_slug?.trim();
    if (!ticker) continue;

    if (!row.order_id?.trim()) continue; // can't re-check fill

    let order: Awaited<ReturnType<typeof getKalshiOrder>> = null;
    try {
      order = await getKalshiOrder(row.order_id.trim());
    } catch {
      continue;
    }
    const fillCount = order?.fill_count ?? 0;
    if (fillCount === 0) {
      const newOutcome = 'no_fill';
      if (row.outcome !== newOutcome) {
        const { error: updateError } = await supabase
          .from('positions')
          .update({ outcome: newOutcome, resolved_at: new Date().toISOString() })
          .eq('id', row.id);
        if (!updateError) {
          updated++;
          console.log(`Re-resolved ${row.bot} ${ticker}: ${row.outcome} → no_fill (order not filled)`);
        }
      }
      continue;
    }

    const settlement = byTicker.get(ticker);
    if (!settlement) continue;

    const result = settlement.market_result;
    if (result === 'void' || result === 'scalar') {
      const newOutcome = 'no_fill';
      if (row.outcome !== newOutcome) {
        const { error: updateError } = await supabase
          .from('positions')
          .update({ outcome: newOutcome, resolved_at: new Date().toISOString() })
          .eq('id', row.id);
        if (!updateError) {
          updated++;
          console.log(`Re-resolved ${row.bot} ${ticker}: ${row.outcome} → no_fill (market ${result})`);
        }
      }
      continue;
    }

    const yesCount = settlement.yes_count ?? 0;
    const noCount = settlement.no_count ?? 0;
    const hadYes = yesCount > 0 && noCount === 0;
    const hadNo = noCount > 0 && yesCount === 0;
    let newOutcome: 'win' | 'loss' | null = null;
    if (hadYes) newOutcome = result === 'yes' ? 'win' : 'loss';
    else if (hadNo) newOutcome = result === 'no' ? 'win' : 'loss';
    if (newOutcome == null) continue;

    if (row.outcome !== newOutcome) {
      const { error: updateError } = await supabase
        .from('positions')
        .update({ outcome: newOutcome, resolved_at: new Date().toISOString() })
        .eq('id', row.id);
      if (!updateError) {
        updated++;
        console.log(`Re-resolved ${row.bot} ${ticker}: ${row.outcome} → ${newOutcome}`);
      }
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  console.log(`Updated ${updated} Kalshi position(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
