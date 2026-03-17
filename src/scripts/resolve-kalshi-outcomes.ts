/**
 * Resolve win/loss for Kalshi B1/B2/B3 positions. Updates positions.outcome and resolved_at.
 * Run every 15 min at :03, :18, :33, :48 (calm period) via cron on D1. Uses KALSHI_* and SUPABASE_* from env.
 *
 * Strategy:
 * - Win/loss only when we have proof of fill: (1) settlement shows we held a position (yes_count or no_count > 0),
 *   OR (2) order.fill_count > 0. We never set win/loss when settlement shows held none and fill_count === 0.
 * - When settlement shows held yes/no we use that side and market_result → win/loss (settlement is proof of fill).
 * - When settlement shows held none we require fill_count > 0 and use order.side + market_result.
 * - When fill_count === 0 and settlement held none → no_fill.
 * - Every run re-checks a sliding window of recent positions plus all unresolved.
 */
import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getKalshiOrder } from '../kalshi/orders.js';
import { getKalshiSettlements, type KalshiSettlement } from '../kalshi/settlements.js';

/** Re-check the most recent positions every run (even if already no_fill). One-time backfill: pass a number, e.g. npx tsx resolve-kalshi-outcomes.ts 500 */
const DEFAULT_RECHECK_LIMIT = 20;
/** How far back to fetch settlements (seconds). */
const SETTLEMENT_LOOKBACK_DAYS = 30;

type PositionRow = {
  id: string;
  bot: string;
  ticker_or_slug: string | null;
  order_id: string | null;
  entered_at: string | null;
  outcome?: string | null;
};

/** True if this settlement row shows we held a position (proof of fill). */
function settlementShowsPosition(s: KalshiSettlement): boolean {
  return ((s.yes_count ?? 0) > 0) || ((s.no_count ?? 0) > 0);
}

/**
 * Build map ticker -> best settlement. Prefer a row that shows we held (yes_count or no_count > 0);
 * among those use latest settled_time. Otherwise use latest by settled_time. Avoids overwriting
 * a "we held" row with a later 0/0 row that might exist in the API.
 */
function settlementMap(settlements: KalshiSettlement[]): Map<string, KalshiSettlement> {
  const map = new Map<string, KalshiSettlement>();
  for (const s of settlements) {
    const existing = map.get(s.ticker);
    const sHasPosition = settlementShowsPosition(s);
    const existingHasPosition = existing ? settlementShowsPosition(existing) : false;
    const sTime = new Date(s.settled_time).getTime();
    const existingTime = existing ? new Date(existing.settled_time).getTime() : 0;
    if (!existing) {
      map.set(s.ticker, s);
      continue;
    }
    if (sHasPosition && !existingHasPosition) {
      map.set(s.ticker, s);
      continue;
    }
    if (!sHasPosition && existingHasPosition) continue;
    if (sTime > existingTime) map.set(s.ticker, s);
  }
  return map;
}

type MarketOutcome = 'win' | 'loss' | 'no_fill';

function heldSideFromSettlement(settlement: KalshiSettlement): 'yes' | 'no' | 'none' | 'both' {
  const yesCount = settlement.yes_count ?? 0;
  const noCount = settlement.no_count ?? 0;
  const heldYes = yesCount > 0;
  const heldNo = noCount > 0;
  if (heldYes && !heldNo) return 'yes';
  if (heldNo && !heldYes) return 'no';
  if (!heldYes && !heldNo) return 'none';
  return 'both';
}

function outcomeFromSettlementAndSide(settlement: KalshiSettlement, side: 'yes' | 'no'): MarketOutcome | null {
  const result = settlement.market_result;
  if (result === 'void' || result === 'scalar') return 'no_fill';
  if (result !== 'yes' && result !== 'no') return null;
  return side === result ? 'win' : 'loss';
}

function uniqById(rows: PositionRow[]): PositionRow[] {
  const seen = new Set<string>();
  const out: PositionRow[] = [];
  for (const r of rows) {
    if (!r?.id || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

async function main() {
  // One-time backfill: npx tsx resolve-kalshi-outcomes.ts 500 → re-check last 500 positions
  const argLimit = process.argv[2];
  const recheckLimit =
    typeof argLimit === 'string' && /^\d+$/.test(argLimit)
      ? Math.min(2000, Math.max(1, parseInt(argLimit, 10)))
      : DEFAULT_RECHECK_LIMIT;
  if (recheckLimit !== DEFAULT_RECHECK_LIMIT) {
    console.log(`Kalshi resolver: one-time backfill recheck_limit=${recheckLimit}`);
  }

  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
    process.exit(1);
  }
  const supabase: SupabaseClient = createClient(url, key);

  // Fetch settlements (backlog) once per run; used for all resolution decisions.
  const minTs = Math.floor(Date.now() / 1000) - SETTLEMENT_LOOKBACK_DAYS * 24 * 3600;
  const allSettlements: KalshiSettlement[] = [];
  let cursor: string | undefined;
  do {
    const res = await getKalshiSettlements({ min_ts: minTs, limit: 200, cursor });
    allSettlements.push(...(res.settlements ?? []));
    cursor = res.cursor;
  } while (cursor);
  const byTicker = settlementMap(allSettlements);

  // Unresolved positions (outcome IS NULL)
  const { data: rows, error: selectError } = await supabase
    .from('positions')
    .select('id, bot, ticker_or_slug, order_id, entered_at')
    .eq('venue', 'kalshi')
    .in('bot', ['B1', 'B2', 'B3'])
    .is('outcome', null);

  if (selectError) {
    console.error('Select positions failed:', selectError.message);
    process.exit(1);
  }
  const unresolved = (rows ?? []) as PositionRow[];

  // Recent re-check window (includes no_fill, win, loss) so we can correct mistakes automatically.
  const { data: recentRows, error: recentError } = await supabase
    .from('positions')
    .select('id, bot, ticker_or_slug, order_id, entered_at, outcome')
    .eq('venue', 'kalshi')
    .in('bot', ['B1', 'B2', 'B3'])
    .order('entered_at', { ascending: false })
    .limit(recheckLimit);
  if (recentError) {
    console.error('Select recent positions failed:', recentError.message);
  }
  const recent = (recentRows ?? []) as PositionRow[];

  const positions = uniqById([...unresolved, ...recent]);
  console.log(
    `Kalshi resolver: settlements=${allSettlements.length} tickers=${byTicker.size} unresolved=${unresolved.length} recent=${recent.length} processing=${positions.length}`
  );

  let updated = 0;
  let skippedNoSettlement = 0;
  let skippedNoOrder = 0;
  let skippedNoTicker = 0;
  let skippedUnknownSide = 0;
  let skippedHeldBoth = 0;

  for (const row of positions) {
    const ticker = row.ticker_or_slug?.trim();
    if (!ticker) {
      skippedNoTicker++;
      continue;
    }

    if (!row.order_id?.trim()) {
      skippedNoOrder++;
      continue;
    }

    const settlement = byTicker.get(ticker);
    if (!settlement) {
      skippedNoSettlement++;
      continue;
    }

    const result = settlement.market_result;
    if (result === 'void' || result === 'scalar') {
      if (row.outcome === 'no_fill') continue;
      const { error: updateError } = await supabase
        .from('positions')
        .update({ outcome: 'no_fill', resolved_at: new Date().toISOString() })
        .eq('id', row.id);
      if (!updateError) {
        updated++;
        console.log(`Resolved ${row.bot} ${ticker}: ${row.outcome ?? 'null'} → no_fill (market ${result})`);
      }
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    if (result !== 'yes' && result !== 'no') continue;

    const heldSide = heldSideFromSettlement(settlement);

    let order: Awaited<ReturnType<typeof getKalshiOrder>> = null;
    try {
      order = await getKalshiOrder(row.order_id.trim());
    } catch {
      /* API error */
    }

    const fillCount = order?.fill_count ?? 0;
    const orderFilled = fillCount > 0 || order?.status === 'executed';

    if (heldSide === 'none') {
      if (!orderFilled) {
        if (row.outcome === 'no_fill') continue;
        const { error: updateError } = await supabase
          .from('positions')
          .update({ outcome: 'no_fill', resolved_at: new Date().toISOString() })
          .eq('id', row.id);
        if (!updateError) {
          updated++;
        console.log(`Resolved ${row.bot} ${ticker}: ${row.outcome ?? 'null'} → no_fill (settlement held none, order not filled)`);
      }
      await new Promise((r) => setTimeout(r, 50));
      } else {
        const side = order?.side === 'yes' || order?.side === 'no' ? order.side : null;
        if (!side) {
          skippedUnknownSide++;
          continue;
        }
        const outcome = outcomeFromSettlementAndSide(settlement, side);
        if (!outcome || outcome === 'no_fill') continue;
        if (row.outcome === outcome) continue;
        const { error: updateError } = await supabase
          .from('positions')
          .update({ outcome, resolved_at: new Date().toISOString() })
          .eq('id', row.id);
        if (!updateError) {
          updated++;
          console.log(`Resolved ${row.bot} ${ticker}: ${row.outcome ?? 'null'} → ${outcome} (order executed, side from order)`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      continue;
    }

    if (heldSide === 'both') {
      skippedHeldBoth++;
      if (orderFilled && (order?.side === 'yes' || order?.side === 'no')) {
        const outcome = outcomeFromSettlementAndSide(settlement, order.side);
        if (outcome && outcome !== 'no_fill' && row.outcome !== outcome) {
          const { error: updateError } = await supabase
            .from('positions')
            .update({ outcome, resolved_at: new Date().toISOString() })
            .eq('id', row.id);
          if (!updateError) {
            updated++;
            console.log(`Resolved ${row.bot} ${ticker}: ${row.outcome ?? 'null'} → ${outcome} (held both, side from order)`);
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      continue;
    }

    const outcome = outcomeFromSettlementAndSide(settlement, heldSide);
    if (!outcome || outcome === 'no_fill') continue;
    if (row.outcome === outcome) continue;

    const { error: updateError } = await supabase
      .from('positions')
      .update({ outcome, resolved_at: new Date().toISOString() })
      .eq('id', row.id);

    if (updateError) {
      console.error(`Update position ${row.id}:`, updateError.message);
      continue;
    }
    updated++;
    console.log(`Resolved ${row.bot} ${ticker}: ${row.outcome ?? 'null'} → ${outcome} (settlement held ${heldSide})`);
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(
    `Updated ${updated} Kalshi position(s). Skipped: no_ticker=${skippedNoTicker} no_order=${skippedNoOrder} no_settlement=${skippedNoSettlement} held_both=${skippedHeldBoth} unknown_side=${skippedUnknownSide}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
