/**
 * Live price feed for B4: fetches 1-minute BTCUSDT klines from Binance REST.
 * Maintains a rolling buffer of recent candles for signal computation.
 * Falls back across multiple Binance endpoints (geo-block resilience).
 */

import type { Candle1m } from './download-candles.js';

const BINANCE_ENDPOINTS = [
  'https://api.binance.com/api/v3/klines',
  'https://api.binance.us/api/v3/klines',
  'https://api1.binance.com/api/v3/klines',
];

const SYMBOL = 'BTCUSDT';
const BUFFER_SIZE = 30; // keep last 30 one-minute candles

let workingEndpoint: string | null = null;

function parseKline(k: unknown[]): Candle1m {
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

async function fetchRecentKlines(limit: number = BUFFER_SIZE): Promise<Candle1m[]> {
  const endpoints = workingEndpoint ? [workingEndpoint, ...BINANCE_ENDPOINTS.filter((e) => e !== workingEndpoint)] : BINANCE_ENDPOINTS;

  for (const base of endpoints) {
    const url = `${base}?symbol=${SYMBOL}&interval=1m&limit=${limit}`;
    try {
      const res = await fetch(url);
      if (res.status === 451 || res.status === 403) continue;
      if (!res.ok) continue;
      const raw = (await res.json()) as unknown[][];
      workingEndpoint = base;
      return raw.map(parseKline);
    } catch {
      continue;
    }
  }
  throw new Error('All Binance endpoints failed');
}

/** Get current BTC spot price. */
async function fetchSpotPrice(): Promise<number> {
  const endpoints = [
    'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
    'https://api.binance.us/api/v3/ticker/price?symbol=BTCUSDT',
    'https://api1.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url);
      if (res.status === 451 || res.status === 403) continue;
      if (!res.ok) continue;
      const data = (await res.json()) as { price: string };
      return parseFloat(data.price);
    } catch {
      continue;
    }
  }
  // Fallback: CoinGecko
  const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
  const data = (await res.json()) as { bitcoin: { usd: number } };
  return data.bitcoin.usd;
}

// ---------------------------------------------------------------------------
// PriceFeed class — maintains rolling buffer
// ---------------------------------------------------------------------------

export class PriceFeed {
  private buffer: Candle1m[] = [];
  private lastFetchMs = 0;
  private windowOpenPrice: number | null = null;
  private currentWindowStart = 0;

  /** Fetch latest candles and update buffer. Call every ~10-15 seconds. */
  async refresh(): Promise<void> {
    const now = Date.now();
    if (now - this.lastFetchMs < 5_000) return; // debounce
    this.lastFetchMs = now;

    try {
      const candles = await fetchRecentKlines(BUFFER_SIZE);
      this.buffer = candles;
    } catch (e) {
      console.error('[PriceFeed] refresh failed:', e instanceof Error ? e.message : e);
    }
  }

  /** Get the rolling buffer of recent 1-min candles. */
  getBuffer(): Candle1m[] {
    return [...this.buffer];
  }

  /** Get candles that fall BEFORE the given timestamp. */
  getCandlesBefore(timestampMs: number, count: number): Candle1m[] {
    return this.buffer.filter((c) => c.openTime < timestampMs).slice(-count);
  }

  /** Get candles that fall WITHIN the given time range. */
  getCandlesInRange(startMs: number, endMs: number): Candle1m[] {
    return this.buffer.filter((c) => c.openTime >= startMs && c.openTime < endMs);
  }

  /** Record the open price at the start of a new 5-min window. */
  setWindowOpen(windowStartMs: number): void {
    if (this.currentWindowStart === windowStartMs) return;
    this.currentWindowStart = windowStartMs;
    // Use the close of the last candle before the window as the "open"
    const prior = this.buffer.filter((c) => c.closeTime <= windowStartMs);
    this.windowOpenPrice = prior.length > 0 ? prior[prior.length - 1].close : null;
  }

  /** Get the window open price (or fetch spot as fallback). */
  async getWindowOpen(): Promise<number> {
    if (this.windowOpenPrice != null) return this.windowOpenPrice;
    return fetchSpotPrice();
  }

  /** Get current spot price. */
  async getSpotPrice(): Promise<number> {
    // Use the most recent candle close if fresh enough
    if (this.buffer.length > 0) {
      const last = this.buffer[this.buffer.length - 1];
      if (Date.now() - last.closeTime < 90_000) return last.close;
    }
    return fetchSpotPrice();
  }
}
