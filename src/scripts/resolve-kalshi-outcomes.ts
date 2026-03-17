/**
 * Resolve win/loss for Kalshi B1/B2/B3 positions. Updates positions.outcome and resolved_at.
 * Run every 15 min at :03, :18, :33, :48 (calm period) via cron on D1. Uses KALSHI_* and SUPABASE_* from env.
 *
 * Strategy:
 * - Resolve from Kalshi settlements repeatedly (cron every 15 min). Do not rely on fill_count timing gates.
 * - Every run, re-check a small sliding window of the most recent Kalshi positions (RECENT_RECHECK_LIMIT)
 *   so missed settlements or delayed API data get corrected automatically.
 * - Also process all unresolved positions (outcome IS NULL).
 * - Use order.side (yes/no) from GET /portfolio/orders/:id to determine win/loss against settlement.market_result.
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
      continue; // not settled yet (or settlement not in lookback window)
    }

    const heldSide = heldSideFromSettlement(settlement);
    if (heldSide === 'none') {
      // No settled position for this market => unfilled order (or net 0); mark no_fill.
      if (row.outcome === 'no_fill') continue;
      const { error: updateError } = await supabase
        .from('positions')
        .update({ outcome: 'no_fill', resolved_at: new Date().toISOString() })
        .eq('id', row.id);
      if (!updateError) {
        updated++;
        console.log(`Resolved ${row.bot} ${ticker}: ${row.outcome ?? 'null'} → no_fill (settlement held none)`);
      }
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    if (heldSide === 'both') {
      // Ambiguous portfolio holdings; don't overwrite.
      skippedHeldBoth++;
      continue;
    }

    let order: Awaited<ReturnType<typeof getKalshiOrder>> = null;
    try {
      order = await getKalshiOrder(row.order_id.trim());
    } catch {
      /* API error */
    }
    if (!order) {
      skippedNoOrder++;
      continue;
    }
    const sideFromOrder = order.side;
    if (sideFromOrder !== 'yes' && sideFromOrder !== 'no') {
      skippedUnknownSide++;
      continue;
    }
    // Prefer settlement-held side (proves the order filled); order.side is used only for sanity/debug.
    const outcome = outcomeFromSettlementAndSide(settlement, heldSide);
    if (!outcome) continue;
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
    const mismatch = sideFromOrder !== heldSide ? ` (order.side=${sideFromOrder}, held=${heldSide})` : '';
    console.log(`Resolved ${row.bot} ${ticker}: ${row.outcome ?? 'null'} → ${outcome}${mismatch}`);
    await new Promise((r) => setTimeout(r, 100)); // gentle on API
  }

  console.log(
    `Updated ${updated} Kalshi position(s). Skipped: no_ticker=${skippedNoTicker} no_order=${skippedNoOrder} no_settlement=${skippedNoSettlement} held_both=${skippedHeldBoth} unknown_side=${skippedUnknownSide}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
