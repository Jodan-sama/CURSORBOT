/**
 * Resolve win/loss for Kalshi B1/B2/B3 positions. Updates positions.outcome and resolved_at.
 * Run every 15 min at :03, :18, :33, :48 (calm period) via cron on D1. Uses KALSHI_* and SUPABASE_* from env.
 *
 * Fill check: if order has fill_count 0 or missing, set outcome = 'no_fill' (still shown in dashboard; not counted in win rate).
 * Resolution: GET /portfolio/settlements; match by ticker; derive side from yes_count/no_count; set win/loss.
 * Backlog: all unresolved Kalshi positions are processed (settlements fetched for last 30 days, paginated).
 */
import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getKalshiOrder } from '../kalshi/orders.js';
import { getKalshiSettlements, type KalshiSettlement } from '../kalshi/settlements.js';

type PositionRow = {
  id: string;
  bot: string;
  ticker_or_slug: string | null;
  order_id: string | null;
};

/** Build map ticker -> latest settlement (by settled_time). One settlement per ticker. */
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
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
    process.exit(1);
  }
  const supabase: SupabaseClient = createClient(url, key);

  const { data: rows, error: selectError } = await supabase
    .from('positions')
    .select('id, bot, ticker_or_slug, order_id')
    .eq('venue', 'kalshi')
    .in('bot', ['B1', 'B2', 'B3'])
    .is('outcome', null);

  if (selectError) {
    console.error('Select positions failed:', selectError.message);
    process.exit(1);
  }
  const positions = (rows ?? []) as PositionRow[];
  if (positions.length === 0) {
    console.log('No unresolved Kalshi positions.');
    return;
  }

  // Fetch settlements (last 30 days) for backlog; paginate
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
    if (!ticker) {
      const { error: updateError } = await supabase
        .from('positions')
        .update({ outcome: 'no_fill', resolved_at: new Date().toISOString() })
        .eq('id', row.id);
      if (!updateError) {
        updated++;
        console.log(`Resolved ${row.bot} ${ticker ?? 'no-ticker'}: no_fill (no ticker)`);
      }
      continue;
    }

    // Fill check
    if (!row.order_id?.trim()) {
      const { error: updateError } = await supabase
        .from('positions')
        .update({ outcome: 'no_fill', resolved_at: new Date().toISOString() })
        .eq('id', row.id);
      if (!updateError) {
        updated++;
        console.log(`Resolved ${row.bot} ${ticker}: no_fill (no order_id)`);
      }
      continue;
    }

    let order: Awaited<ReturnType<typeof getKalshiOrder>> = null;
    try {
      order = await getKalshiOrder(row.order_id.trim());
    } catch {
      /* API error */
    }
    if (!order || (order.fill_count ?? 0) === 0) {
      const { error: updateError } = await supabase
        .from('positions')
        .update({ outcome: 'no_fill', resolved_at: new Date().toISOString() })
        .eq('id', row.id);
      if (!updateError) {
        updated++;
        console.log(`Resolved ${row.bot} ${ticker}: no_fill (order not filled)`);
      }
      continue;
    }

    const settlement = byTicker.get(ticker);
    if (!settlement) {
      continue; // not settled yet
    }
    const result = settlement.market_result;
    if (result === 'void' || result === 'scalar') {
      const { error: updateError } = await supabase
        .from('positions')
        .update({ outcome: 'no_fill', resolved_at: new Date().toISOString() })
        .eq('id', row.id);
      if (!updateError) {
        updated++;
        console.log(`Resolved ${row.bot} ${ticker}: no_fill (market ${result})`);
      }
      continue;
    }

    const yesCount = settlement.yes_count ?? 0;
    const noCount = settlement.no_count ?? 0;
    const hadYes = yesCount > 0 && noCount === 0;
    const hadNo = noCount > 0 && yesCount === 0;
    let outcome: 'win' | 'loss' | null = null;
    if (hadYes) outcome = result === 'yes' ? 'win' : 'loss';
    else if (hadNo) outcome = result === 'no' ? 'win' : 'loss';
    if (outcome == null) continue; // both sides held, skip

    const { error: updateError } = await supabase
      .from('positions')
      .update({ outcome, resolved_at: new Date().toISOString() })
      .eq('id', row.id);

    if (updateError) {
      console.error(`Update position ${row.id}:`, updateError.message);
      continue;
    }
    updated++;
    console.log(`Resolved ${row.bot} ${ticker}: ${outcome}`);
    await new Promise((r) => setTimeout(r, 100)); // gentle on API
  }

  console.log(`Updated ${updated} Kalshi position(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
