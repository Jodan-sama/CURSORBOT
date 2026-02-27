/**
 * One-off: Re-resolve Polymarket positions that are outcome = 'no_fill' but were actually filled.
 * Uses Data API to check if the wallet had a trade for the slug; if yes, fetches Gamma and sets win/loss.
 * Run on D2 (or locally with SUPABASE_* and .env.b123c / .env.b5 / .env.d1): npx tsx src/scripts/re-resolve-polymarket-no-fill.ts [days=14]
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';
import { fetchGammaEvent } from '../polymarket/gamma.js';

const DATA_API_BASE = 'https://data-api.polymarket.com';

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

function getWalletFromEnv(envPath: string): string | null {
  if (!existsSync(envPath)) return null;
  const env = parseEnvFile(readFileSync(envPath, 'utf8'));
  return env.POLYMARKET_FUNDER?.trim() || env.POLYMARKET_PROXY_WALLET?.trim() || null;
}

async function hasTradeForSlug(wallet: string, slug: string, sinceSec: number): Promise<boolean> {
  let offset = 0;
  const limit = 100;
  for (let i = 0; i < 15; i++) {
    const res = await fetch(
      `${DATA_API_BASE}/trades?user=${encodeURIComponent(wallet)}&limit=${limit}&offset=${offset}`
    );
    if (!res.ok) return false;
    const page = (await res.json()) as { slug?: string; timestamp?: number }[];
    for (const t of page) {
      if (t.slug === slug && (t.timestamp ?? 0) >= sinceSec) return true;
    }
    if (page.length < limit) break;
    offset += limit;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
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

async function main() {
  const days = Math.max(1, parseInt(process.argv[2] ?? '14', 10));
  const sinceSec = Math.floor(Date.now() / 1000) - days * 24 * 3600;

  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_ANON_KEY required');
    process.exit(1);
  }
  const cwd = process.cwd();
  const b123cWallet = getWalletFromEnv(join(cwd, '.env.b123c'));
  const b5Wallet = getWalletFromEnv(join(cwd, '.env.b5'));
  const d1Wallet = getWalletFromEnv(join(cwd, '.env.d1'));
  const b4Wallet = process.env.POLYMARKET_FUNDER?.trim() || process.env.POLYMARKET_PROXY_WALLET?.trim() || null;

  function walletForBot(bot: string): string | null {
    if (bot === 'B4') return b4Wallet;
    if (bot === 'B5') return b5Wallet;
    if (bot === 'B1c' || bot === 'B2c' || bot === 'B3c') return b123cWallet;
    if (bot === 'B1' || bot === 'B2' || bot === 'B3') return d1Wallet;
    return null;
  }

  const supabase = createClient(url, key);
  const { data: rows, error } = await supabase
    .from('positions')
    .select('id, bot, ticker_or_slug, raw, entered_at')
    .eq('venue', 'polymarket')
    .eq('outcome', 'no_fill')
    .not('ticker_or_slug', 'is', null)
    .gte('entered_at', new Date(sinceSec * 1000).toISOString());

  if (error) {
    console.error('Select failed:', error.message);
    process.exit(1);
  }
  const positions = (rows ?? []) as { id: string; bot: string; ticker_or_slug: string | null; raw: Record<string, unknown> | null; entered_at: string }[];
  console.log(`Found ${positions.length} no_fill Polymarket positions in last ${days} days.`);

  let updated = 0;
  for (const row of positions) {
    const slug = row.ticker_or_slug!.trim();
    const wallet = walletForBot(row.bot);
    if (!wallet) {
      console.warn(`No wallet for ${row.bot}, skip ${slug}`);
      continue;
    }
    const hasTrade = await hasTradeForSlug(wallet, slug, sinceSec);
    if (!hasTrade) continue;

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
    const ourSide = getOurSide(row.raw ?? null);
    if (ourSide == null || winningSide == null) continue;
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
    console.log(`Re-resolved ${row.bot} ${slug}: ${outcome}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`Updated ${updated} position(s) from no_fill to win/loss.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
