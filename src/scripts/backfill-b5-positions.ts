/**
 * Backfill B5 positions that were never logged (e.g. when Supabase was missing on D3).
 * Fetches trades from Polymarket Data API for the B5 wallet, filters *-updown-5m-* markets,
 * and inserts rows into Supabase positions. Resolver will then set outcome from Gamma (B5 with
 * null order_id is allowed to resolve from Gamma).
 *
 * Run on D2 or locally with SUPABASE_URL, SUPABASE_ANON_KEY and B5 wallet in .env.b5 or env.
 * Usage: npx tsx src/scripts/backfill-b5-positions.ts [since_days=1]
 */

import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';
import type { Asset } from '../db/supabase.js';

const DATA_API_BASE = 'https://data-api.polymarket.com';

/** B5 5m slugs only */
const B5_SLUG_RE = /^(eth|sol|xrp)-updown-5m-\d+$/;

type DataTrade = {
  slug?: string;
  outcome?: string;
  side?: string;
  size?: number;
  price?: number;
  timestamp?: number;
  asset?: string;
  [k: string]: unknown;
};

function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.replace(/#.*/, '').trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

function getB5Wallet(): string {
  const envPath = join(process.cwd(), '.env.b5');
  if (existsSync(envPath)) {
    const env = parseEnvFile(readFileSync(envPath, 'utf8'));
    const w = env.POLYMARKET_PROXY_WALLET?.trim() || env.POLYMARKET_FUNDER?.trim();
    if (w) return w;
  }
  const w =
    process.env.POLYMARKET_PROXY_WALLET?.trim() ||
    process.env.POLYMARKET_FUNDER?.trim() ||
    '';
  return w;
}

function assetFromSlug(slug: string): Asset {
  if (slug.startsWith('eth')) return 'ETH';
  if (slug.startsWith('sol')) return 'SOL';
  if (slug.startsWith('xrp')) return 'XRP';
  return 'ETH';
}

async function main(): Promise<void> {
  const sinceDays = Math.max(1, parseInt(process.argv[2] ?? '1', 10));
  const sinceSec = Math.floor(Date.now() / 1000) - sinceDays * 24 * 60 * 60;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_ANON_KEY required');
    process.exit(1);
  }
  const wallet = getB5Wallet();
  if (!wallet) {
    console.error('B5 wallet required: set in .env.b5 (POLYMARKET_PROXY_WALLET or POLYMARKET_FUNDER) or env');
    process.exit(1);
  }

  const supabase = createClient(url, key);

  const allTrades: DataTrade[] = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const res = await fetch(
      `${DATA_API_BASE}/trades?user=${encodeURIComponent(wallet)}&limit=${limit}&offset=${offset}`
    );
    if (!res.ok) {
      console.error('Data API error:', res.status, await res.text());
      process.exit(1);
    }
    const page = (await res.json()) as DataTrade[];
    if (page.length === 0) break;
    allTrades.push(...page);
    if (page.length < limit) break;
    offset += limit;
    if (offset >= 1000) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  const b5Trades = allTrades.filter(
    (t) =>
      t.slug &&
      B5_SLUG_RE.test(t.slug) &&
      (t.timestamp ?? 0) >= sinceSec &&
      (t.side === 'BUY' || t.side === 'SELL')
  );
  // Prefer BUY as entry; if we have both BUY and SELL for same slug in same window, we only want the entry (BUY)
  const bySlugTime = new Map<string, DataTrade>();
  for (const t of b5Trades) {
    const slug = t.slug!;
    const ts = t.timestamp ?? 0;
    const windowStart = Math.floor(ts / 300_000) * 300_000;
    const key = `${slug}-${windowStart}`;
    const existing = bySlugTime.get(key);
    if (!existing || (t.side === 'BUY' && existing.side !== 'BUY')) {
      bySlugTime.set(key, t);
    }
  }
  const toInsert = [...bySlugTime.values()].filter((t) => t.side === 'BUY');

  console.log(`B5 wallet: ${wallet.slice(0, 10)}…`);
  console.log(`Trades since ${sinceDays} day(s): ${allTrades.length}, B5 5m BUY entries: ${toInsert.length}`);

  let inserted = 0;
  let skipped = 0;
  for (const t of toInsert) {
    const slug = t.slug!;
    const tsSec = t.timestamp ?? 0;
    const ts = tsSec * 1000;
    const enteredAt = new Date(tsSec * 1000).toISOString();
    const asset = assetFromSlug(slug);
    const outcome = (t.outcome ?? '').toLowerCase();
    const direction = outcome === 'up' || outcome === 'down' ? outcome : 'up';
    const size = Number(t.size) || 0;
    const price = Number(t.price) || 0;
    const positionSizeUsd = size * price;

    const { data: existing } = await supabase
      .from('positions')
      .select('id')
      .eq('bot', 'B5')
      .eq('ticker_or_slug', slug)
      .gte('entered_at', new Date((tsSec - 120) * 1000).toISOString())
      .lte('entered_at', new Date((tsSec + 120) * 1000).toISOString())
      .limit(1)
      .maybeSingle();

    if (existing) {
      skipped++;
      continue;
    }

    const { error } = await supabase.from('positions').insert({
      bot: 'B5',
      asset,
      venue: 'polymarket',
      strike_spread_pct: 0,
      position_size: positionSizeUsd,
      ticker_or_slug: slug,
      order_id: null,
      raw: {
        strategy: 'spread',
        direction,
        source: 'backfill',
        trade_timestamp: tsSec,
        size,
        price,
      },
      entered_at: enteredAt,
    });

    if (error) {
      console.error(`Insert failed ${slug}:`, error.message);
      continue;
    }
    inserted++;
    console.log(`Inserted B5 ${asset} ${slug} entered_at=${enteredAt} size=$${positionSizeUsd.toFixed(2)}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(`Done. Inserted ${inserted}, skipped (already exist) ${skipped}. Run resolver to set outcomes.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
