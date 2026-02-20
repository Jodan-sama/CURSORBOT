/**
 * One-off backfill: B1/B2/B3 Poly positions that were set to no_fill by the resolver
 * (when it used the wrong wallet) but may have actually filled. Re-checks with D1 client
 * and sets win/loss where appropriate. Run on D2: node dist/scripts/backfill-b123-poly-outcomes.js
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';
import type { ClobClient } from '@polymarket/clob-client';
import { createDerivedPolyClientFromConfig } from '../polymarket/clob.js';
import { fetchGammaEvent } from '../polymarket/gamma.js';

async function applyPolyProxy(): Promise<void> {
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '';
  if (!proxy) return;
  const axios = (await import('axios')).default;
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  const undici = await import('undici');
  undici.setGlobalDispatcher(new undici.ProxyAgent(proxy));
  axios.defaults.httpsAgent = new HttpsProxyAgent(proxy);
  axios.defaults.proxy = false;
}

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

function getWindowEndUnixFromSlug(slug: string): number | null {
  const m5 = /^btc-updown-5m-(\d+)$/.exec(slug);
  if (m5) return parseInt(m5[1], 10) + 300;
  const m15 = /^.+-updown-15m-(\d+)$/.exec(slug);
  if (m15) return parseInt(m15[1], 10) + 900;
  return null;
}

function getWinningOutcomeIndex(outcomePrices: string[]): number | null {
  if (outcomePrices.length !== 2) return null;
  const a = parseFloat(outcomePrices[0]);
  const b = parseFloat(outcomePrices[1]);
  if (a === 1 && b === 0) return 0;
  if (a === 0 && b === 1) return 1;
  return null;
}

function getOurSide(raw: Record<string, unknown> | null): 'Up' | 'Down' | null {
  const d = raw?.direction;
  if (d === 'up' || d === 'yes') return 'Up';
  if (d === 'down' || d === 'no') return 'Down';
  return null;
}

function getWinningSide(outcomes: string[], winningIndex: number): 'Up' | 'Down' | null {
  if (winningIndex < 0 || winningIndex >= outcomes.length) return null;
  const name = outcomes[winningIndex];
  if (name === 'Up') return 'Up';
  if (name === 'Down') return 'Down';
  return null;
}

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
  const supabase = createClient(url, key);

  await applyPolyProxy();

  let d1Client: ClobClient | null = null;
  const d1EnvPath = join(process.cwd(), '.env.d1');
  try {
    const content = readFileSync(d1EnvPath, 'utf8');
    const env = parseEnvFile(content);
    const pk = env.POLYMARKET_PRIVATE_KEY?.trim();
    const funder = env.POLYMARKET_FUNDER?.trim();
    if (pk && funder) {
      d1Client = await createDerivedPolyClientFromConfig({ privateKey: pk, funder });
    }
  } catch (e) {
    console.error('Failed to load .env.d1:', e instanceof Error ? e.message : e);
    process.exit(1);
  }
  if (!d1Client) {
    console.error('No D1 client');
    process.exit(1);
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const nowSec = Math.floor(Date.now() / 1000);
  const minWindowEndSec = nowSec - 600;

  const { data: rows, error } = await supabase
    .from('positions')
    .select('id, bot, ticker_or_slug, order_id, raw')
    .in('bot', ['B1', 'B2', 'B3'])
    .eq('venue', 'polymarket')
    .eq('outcome', 'no_fill')
    .not('order_id', 'is', null)
    .gte('entered_at', since)
    .order('entered_at', { ascending: true });

  if (error) {
    console.error('Select failed:', error.message);
    process.exit(1);
  }
  const positions = rows ?? [];
  console.log(`Found ${positions.length} B1/B2/B3 Poly no_fill positions (last 7 days) to re-check.`);

  let updated = 0;
  for (const row of positions) {
    const slug = (row.ticker_or_slug ?? '').trim();
    if (!slug) continue;
    let filled = false;
    try {
      const order = await d1Client.getOrder(row.order_id!.trim());
      filled = isOrderFilled(order?.size_matched);
    } catch {
      // still not fillable or API error
    }
    if (!filled) continue;

    const windowEndSec = getWindowEndUnixFromSlug(slug);
    if (windowEndSec == null || windowEndSec > minWindowEndSec) continue;

    let event: Awaited<ReturnType<typeof fetchGammaEvent>>;
    try {
      event = await fetchGammaEvent(slug);
    } catch (e) {
      console.warn(`Gamma ${slug}:`, e instanceof Error ? e.message : e);
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
    if (winningIdx == null) continue;
    const winningSide = getWinningSide(outcomes, winningIdx);
    const ourSide = getOurSide((row.raw as Record<string, unknown>) ?? null);
    if (winningSide == null || ourSide == null) continue;
    const outcome = ourSide === winningSide ? 'win' : 'loss';

    const { error: updateError } = await supabase
      .from('positions')
      .update({ outcome, resolved_at: new Date().toISOString() })
      .eq('id', row.id);

    if (updateError) {
      console.error(`Update ${row.id}:`, updateError.message);
      continue;
    }
    updated++;
    console.log(`Backfilled ${row.bot} ${slug}: ${outcome}`);
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`Done. Updated ${updated} position(s) to win/loss.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
