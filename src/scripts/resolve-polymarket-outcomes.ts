/**
 * Resolve win/loss for Polymarket B4 and B1c/B2c/B3c positions using Polymarket Gamma API.
 * Updates positions.outcome and positions.resolved_at once per position (idempotent).
 * Run every 5–10 min via cron (e.g. on D2). Uses SUPABASE_* from env.
 *
 * Fill check: only resolved positions with order_id get win/loss; if order has size_matched 0 or missing, set outcome = 'no_fill' (dashboard hides these).
 * Resolution: fetch event by slug; after market closes, outcomePrices become [1,0] or [0,1].
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { ClobClient } from '@polymarket/clob-client';
import { getOrCreateDerivedPolyClient, createDerivedPolyClientFromConfig } from '../polymarket/clob.js';
import { fetchGammaEvent } from '../polymarket/gamma.js';

type PositionRow = {
  id: string;
  bot: string;
  ticker_or_slug: string | null;
  order_id: string | null;
  raw: Record<string, unknown> | null;
};

/** Window end (unix seconds) from slug. 5m: btc-updown-5m-{start} → end = start+300. 15m: *-updown-15m-{start} → end = start+900. */
function getWindowEndUnixFromSlug(slug: string): number | null {
  const m5 = /^btc-updown-5m-(\d+)$/.exec(slug);
  if (m5) return parseInt(m5[1], 10) + 300;
  const m15 = /^.+-updown-15m-(\d+)$/.exec(slug);
  if (m15) return parseInt(m15[1], 10) + 900;
  return null;
}

/** Resolved market: outcomePrices are ["1","0"] or ["0","1"]. Returns 0 = first outcome (Up), 1 = second (Down), or null if not resolved. */
function getWinningOutcomeIndex(outcomePrices: string[]): number | null {
  if (outcomePrices.length !== 2) return null;
  const a = parseFloat(outcomePrices[0]);
  const b = parseFloat(outcomePrices[1]);
  if (a === 1 && b === 0) return 0;
  if (a === 0 && b === 1) return 1;
  return null;
}

/** Our side from raw.direction: B4 uses 'up'|'down', B1c uses 'yes'|'no'. Returns 'Up'|'Down' or null. */
function getOurSide(raw: Record<string, unknown> | null): 'Up' | 'Down' | null {
  const d = raw?.direction;
  if (d === 'up' || d === 'yes') return 'Up';
  if (d === 'down' || d === 'no') return 'Down';
  return null;
}

/** Outcome names from Gamma (e.g. ["Up","Down"]). Index 0 = first outcome, 1 = second. */
function getWinningSide(outcomes: string[], winningIndex: number): 'Up' | 'Down' | null {
  if (winningIndex < 0 || winningIndex >= outcomes.length) return null;
  const name = outcomes[winningIndex];
  if (name === 'Up') return 'Up';
  if (name === 'Down') return 'Down';
  return null;
}

/** Parse .env-style file into key-value map. */
function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.replace(/#.*/, '').trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Return true if order was filled (size_matched > 0). */
function isOrderFilled(sizeMatched: string | undefined): boolean {
  if (sizeMatched == null || sizeMatched === '') return false;
  const n = parseFloat(sizeMatched);
  return Number.isFinite(n) && n > 0;
}

async function main() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
    process.exit(1);
  }
  const supabase: SupabaseClient = createClient(url, key);
  const nowSec = Math.floor(Date.now() / 1000);
  const minWindowEndSec = nowSec - 600; // only resolve if window ended at least 10 min ago (allow Polymarket to finalize)

  const { data: rows, error: selectError } = await supabase
    .from('positions')
    .select('id, bot, ticker_or_slug, order_id, raw')
    .eq('venue', 'polymarket')
    .in('bot', ['B4', 'B1c', 'B2c', 'B3c'])
    .is('outcome', null)
    .not('ticker_or_slug', 'is', null);

  if (selectError) {
    console.error('Select positions failed:', selectError.message);
    process.exit(1);
  }
  const positions = (rows ?? []) as PositionRow[];
  if (positions.length === 0) {
    console.log('No unresolved Polymarket positions.');
    return;
  }

  let b4Client: ClobClient | null = null;
  let b123cClient: ClobClient | null = null;
  try {
    b4Client = await getOrCreateDerivedPolyClient();
  } catch (e) {
    console.warn('B4 CLOB client (derive) failed:', e instanceof Error ? e.message : e);
  }
  const b123cEnvPath = join(process.cwd(), '.env.b123c');
  try {
    const content = readFileSync(b123cEnvPath, 'utf8');
    const env = parseEnvFile(content);
    const pk = env.POLYMARKET_PRIVATE_KEY?.trim();
    const funder = env.POLYMARKET_FUNDER?.trim();
    if (pk && funder) {
      b123cClient = await createDerivedPolyClientFromConfig({ privateKey: pk, funder });
    }
  } catch {
    // .env.b123c missing or invalid; only B4 orders can be fill-checked
  }

  let updated = 0;
  for (const row of positions) {
    const slug = row.ticker_or_slug!.trim();

    // Fill check: only set win/loss if order was filled. Otherwise set no_fill (dashboard hides).
    if (!row.order_id?.trim()) {
      const { error: updateError } = await supabase
        .from('positions')
        .update({ outcome: 'no_fill', resolved_at: new Date().toISOString() })
        .eq('id', row.id);
      if (updateError) console.error(`Update no_fill (no order_id) ${row.id}:`, updateError.message);
      else {
        updated++;
        console.log(`Resolved ${row.bot} ${slug}: no_fill (no order_id)`);
      }
      continue;
    }

    const clob = row.bot === 'B4' ? b4Client : b123cClient;
    if (clob) {
      let filled = false;
      try {
        const order = await clob.getOrder(row.order_id.trim());
        filled = isOrderFilled(order?.size_matched);
      } catch {
        // order not found or API error → treat as unfilled
      }
      if (!filled) {
        const { error: updateError } = await supabase
          .from('positions')
          .update({ outcome: 'no_fill', resolved_at: new Date().toISOString() })
          .eq('id', row.id);
        if (updateError) console.error(`Update no_fill ${row.id}:`, updateError.message);
        else {
          updated++;
          console.log(`Resolved ${row.bot} ${slug}: no_fill (order not filled)`);
        }
        continue;
      }
    }
    // No CLOB client for this bot → skip fill check; still allow Gamma resolution below (e.g. B123c without .env.b123c)

    const windowEndSec = getWindowEndUnixFromSlug(slug);
    if (windowEndSec == null) continue;
    if (windowEndSec > minWindowEndSec) continue; // not old enough to resolve

    let event: Awaited<ReturnType<typeof fetchGammaEvent>>;
    try {
      event = await fetchGammaEvent(slug);
    } catch (e) {
      console.warn(`Gamma fetch ${slug}:`, e instanceof Error ? e.message : e);
      continue;
    }
    if (!event.markets?.length) continue;
    const market = event.markets[0];
    const outcomePrices = (typeof market.outcomePrices === 'string'
      ? JSON.parse(market.outcomePrices || '[]')
      : market.outcomePrices) as string[];
    const outcomes = (typeof market.outcomes === 'string'
      ? JSON.parse(market.outcomes || '["Up","Down"]')
      : market.outcomes) as string[];
    const winningIdx = getWinningOutcomeIndex(outcomePrices);
    if (winningIdx == null) continue; // not resolved yet
    const winningSide = getWinningSide(outcomes, winningIdx);
    const ourSide = getOurSide(row.raw ?? null);
    if (winningSide == null || ourSide == null) continue;
    const outcome = ourSide === winningSide ? 'win' : 'loss';

    const { error: updateError } = await supabase
      .from('positions')
      .update({ outcome, resolved_at: new Date().toISOString() })
      .eq('id', row.id);

    if (updateError) {
      console.error(`Update position ${row.id}:`, updateError.message);
      continue;
    }
    updated++;
    console.log(`Resolved ${row.bot} ${slug}: ${outcome}`);
    await new Promise((r) => setTimeout(r, 200)); // gentle on Gamma
  }

  console.log(`Updated ${updated} position(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
