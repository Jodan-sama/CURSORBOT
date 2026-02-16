/**
 * Download historical 1-minute BTCUSDT candles from Binance public API.
 * Saves to a local JSON file for backtesting.
 *
 * Usage: npx tsx src/b4-5m/download-candles.ts [--days 180]
 */

import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Candle1m {
  openTime: number;   // ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;  // ms
  takerBuyVolume: number;
}

const BINANCE_ENDPOINTS = [
  'https://api.binance.com/api/v3/klines',
  'https://api.binance.us/api/v3/klines',
  'https://api1.binance.com/api/v3/klines',
  'https://api3.binance.com/api/v3/klines',
];
const SYMBOL = 'BTCUSDT';
const INTERVAL = '1m';
const LIMIT = 1000; // max per request

function parseKlineRow(k: unknown[]): Candle1m {
  return {
    openTime: k[0] as number,
    open: parseFloat(k[1] as string),
    high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string),
    close: parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string),
    closeTime: k[6] as number,
    takerBuyVolume: parseFloat(k[9] as string),
  };
}

async function fetchKlines(startTime: number, endTime: number): Promise<Candle1m[]> {
  for (const base of BINANCE_ENDPOINTS) {
    const url = `${base}?symbol=${SYMBOL}&interval=${INTERVAL}&startTime=${startTime}&endTime=${endTime}&limit=${LIMIT}`;
    try {
      const res = await fetch(url);
      if (res.status === 451 || res.status === 403) continue; // geo-blocked, try next
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Binance ${res.status}: ${text}`);
      }
      const raw = (await res.json()) as unknown[][];
      return raw.map(parseKlineRow);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('451') || msg.includes('403') || msg.includes('restricted')) continue;
      throw e;
    }
  }
  throw new Error('All Binance endpoints geo-blocked. Run from the droplet or use a proxy.');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function downloadCandles(days: number): Promise<Candle1m[]> {
  const endMs = Date.now();
  const startMs = endMs - days * 24 * 60 * 60 * 1000;

  const outPath = join(__dirname, '..', '..', 'data', `btcusdt-1m-${days}d.json`);
  if (existsSync(outPath)) {
    console.log(`Loading cached data from ${outPath}`);
    return JSON.parse(readFileSync(outPath, 'utf-8')) as Candle1m[];
  }

  console.log(`Downloading ${days} days of 1m BTCUSDT candles from Binance...`);
  const allCandles: Candle1m[] = [];
  let cursor = startMs;
  let batch = 0;

  while (cursor < endMs) {
    const candles = await fetchKlines(cursor, endMs);
    if (candles.length === 0) break;
    allCandles.push(...candles);
    batch++;
    const lastTime = candles[candles.length - 1].openTime;
    cursor = lastTime + 60_000; // next minute
    if (batch % 50 === 0) {
      const pct = ((cursor - startMs) / (endMs - startMs) * 100).toFixed(1);
      console.log(`  ${batch} batches, ${allCandles.length} candles (${pct}%)`);
    }
    await sleep(200); // rate limit: 5 req/s
  }

  // Deduplicate by openTime
  const seen = new Set<number>();
  const deduped = allCandles.filter((c) => {
    if (seen.has(c.openTime)) return false;
    seen.add(c.openTime);
    return true;
  });
  deduped.sort((a, b) => a.openTime - b.openTime);

  // Save
  const dataDir = join(__dirname, '..', '..', 'data');
  if (!existsSync(dataDir)) {
    const { mkdirSync } = await import('fs');
    mkdirSync(dataDir, { recursive: true });
  }
  writeFileSync(outPath, JSON.stringify(deduped));
  console.log(`Saved ${deduped.length} candles to ${outPath}`);
  return deduped;
}

// CLI entry
if (process.argv[1]?.endsWith('download-candles.ts') || process.argv[1]?.endsWith('download-candles.js')) {
  const daysArg = process.argv.indexOf('--days');
  const days = daysArg >= 0 ? parseInt(process.argv[daysArg + 1], 10) : 180;
  downloadCandles(days).then((c) => {
    console.log(`Done. Total candles: ${c.length}`);
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
