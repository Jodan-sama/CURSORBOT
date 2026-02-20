/**
 * Live price feed for B4.
 *
 * Two sources:
 * 1. **Chainlink via Polymarket RTDS** — real-time BTC/USD price that Polymarket
 *    uses to resolve 5-minute markets. Used for window open/close and win/loss
 *    determination. Free WebSocket, no auth, no proxy.
 * 2. **Binance REST** — 1-minute BTCUSDT klines for signal computation (momentum,
 *    RSI, volume). Not used for resolution.
 */

import WebSocket from 'ws';
import type { Candle1m } from './download-candles.js';

// ---------------------------------------------------------------------------
// Chainlink price via Polymarket RTDS WebSocket
// ---------------------------------------------------------------------------

const RTDS_URL = 'wss://ws-live-data.polymarket.com';
const PING_INTERVAL_MS = 5_000;
const RECONNECT_DELAY_MS = 3_000;

let chainlinkPrice: number | null = null;
let chainlinkTimestamp = 0;
let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reconnecting = false;

function connectRTDS(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  reconnecting = false;

  try {
    ws = new WebSocket(RTDS_URL);
  } catch (e) {
    console.error('[RTDS] WebSocket constructor failed:', e instanceof Error ? e.message : e);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    console.log('[RTDS] connected to Polymarket Chainlink feed');
    ws!.send(JSON.stringify({
      action: 'subscribe',
      subscriptions: [{
        topic: 'crypto_prices_chainlink',
        type: '*',
        filters: '{"symbol":"btc/usd"}',
      }],
    }));
    // Ping every 5s to keep connection alive
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'ping' }));
      }
    }, PING_INTERVAL_MS);
  });

  ws.on('message', (raw: WebSocket.Data) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        topic?: string;
        payload?: { symbol?: string; value?: number; timestamp?: number };
      };
      if (msg.topic === 'crypto_prices_chainlink' && msg.payload?.symbol === 'btc/usd' && msg.payload.value) {
        chainlinkPrice = msg.payload.value;
        chainlinkTimestamp = msg.payload.timestamp ?? Date.now();
      }
    } catch { /* ignore non-JSON pings/acks */ }
  });

  ws.on('close', () => {
    console.warn('[RTDS] disconnected');
    scheduleReconnect();
  });

  ws.on('error', (err: Error) => {
    console.error('[RTDS] error:', err.message);
    try { ws?.close(); } catch { /* ignore */ }
    scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  if (reconnecting) return;
  reconnecting = true;
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  setTimeout(connectRTDS, RECONNECT_DELAY_MS);
}

/** Get the latest Chainlink BTC/USD price (the oracle Polymarket uses). */
export function getChainlinkPrice(): { price: number; ageMs: number } | null {
  if (chainlinkPrice == null) return null;
  return { price: chainlinkPrice, ageMs: Date.now() - chainlinkTimestamp };
}

// ---------------------------------------------------------------------------
// Binance REST — 1-minute candles for signal engine
// ---------------------------------------------------------------------------

const BINANCE_ENDPOINTS = [
  'https://api.binance.com/api/v3/klines',
  'https://api.binance.us/api/v3/klines',
  'https://api1.binance.com/api/v3/klines',
];

const SYMBOL = 'BTCUSDT';
const BUFFER_SIZE = 30;

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

// ---------------------------------------------------------------------------
// PriceFeed class
// ---------------------------------------------------------------------------

export class PriceFeed {
  private buffer: Candle1m[] = [];
  private lastFetchMs = 0;

  /** Chainlink price captured at the window boundary. */
  private windowOpenChainlink: number | null = null;
  private currentWindowStart = 0;

  constructor() {
    // Start the RTDS WebSocket on creation
    connectRTDS();
  }

  /** Fetch latest Binance candles and update buffer. */
  async refresh(): Promise<void> {
    const now = Date.now();
    if (now - this.lastFetchMs < 5_000) return;
    this.lastFetchMs = now;

    try {
      const candles = await fetchRecentKlines(BUFFER_SIZE);
      this.buffer = candles;
    } catch (e) {
      console.error('[PriceFeed] refresh failed:', e instanceof Error ? e.message : e);
    }
  }

  getBuffer(): Candle1m[] {
    return [...this.buffer];
  }

  getCandlesBefore(timestampMs: number, count: number): Candle1m[] {
    return this.buffer.filter((c) => c.openTime < timestampMs).slice(-count);
  }

  getCandlesInRange(startMs: number, endMs: number): Candle1m[] {
    return this.buffer.filter((c) => c.openTime >= startMs && c.openTime < endMs);
  }

  /** Retry Chainlink for this many ms after window start before falling back to Binance. */
  private static readonly CHAINLINK_RETRY_MS = 30_000;
  private static readonly CHAINLINK_MAX_AGE_MS = 10_000;

  /**
   * Record the window open price from Chainlink at the window boundary.
   * Called when a new 5-minute window starts. Prefer Chainlink; if not ready, leave null
   * so getWindowOpen() can retry for 30s then fall back to Binance.
   */
  setWindowOpen(windowStartMs: number): void {
    if (this.currentWindowStart === windowStartMs) return;
    this.currentWindowStart = windowStartMs;

    const cl = getChainlinkPrice();
    if (cl && cl.ageMs < PriceFeed.CHAINLINK_MAX_AGE_MS) {
      this.windowOpenChainlink = cl.price;
      console.log(`[PriceFeed] window open (Chainlink): $${cl.price.toFixed(2)} (age ${cl.ageMs}ms)`);
    } else {
      this.windowOpenChainlink = null;
      console.warn(`[PriceFeed] window open: Chainlink not ready yet (will retry up to 30s, then Binance fallback)`);
    }
  }

  /** Get the window open price. Retries Chainlink for 30s, then Binance fallback (cached for window). */
  async getWindowOpen(): Promise<number> {
    if (this.windowOpenChainlink != null) return this.windowOpenChainlink;

    const elapsedSinceWindowStart = Date.now() - this.currentWindowStart;
    if (elapsedSinceWindowStart < PriceFeed.CHAINLINK_RETRY_MS) {
      const cl = getChainlinkPrice();
      if (cl && cl.ageMs < PriceFeed.CHAINLINK_MAX_AGE_MS) {
        this.windowOpenChainlink = cl.price;
        console.log(`[PriceFeed] window open (Chainlink after retry): $${cl.price.toFixed(2)}`);
        return cl.price;
      }
    } else {
      // Past 30s or Chainlink still not ready — use Binance once and cache
      const candles = await fetchRecentKlines(1);
      const price = candles.length > 0 ? candles[0].close : 0;
      if (price > 0) {
        this.windowOpenChainlink = price;
        console.warn(`[PriceFeed] window open fallback (Binance): $${price.toFixed(2)}`);
      }
      return price;
    }
    return 0;
  }

  /**
   * Get current spot price for resolution — uses Chainlink (same as Polymarket oracle).
   * Only falls back to Binance if Chainlink is stale (>15 seconds).
   */
  async getSpotPrice(): Promise<number> {
    const cl = getChainlinkPrice();
    if (cl && cl.ageMs < 15_000) return cl.price;

    // Chainlink stale — warn and fall back to fresh Binance spot
    console.warn(`[PriceFeed] Chainlink stale (age ${cl?.ageMs ?? 'null'}ms), falling back to Binance`);
    const candles = await fetchRecentKlines(1);
    if (candles.length > 0) return candles[candles.length - 1].close;
    return 0;
  }

  /** Is the Chainlink feed connected and fresh? */
  isChainlinkLive(): boolean {
    const cl = getChainlinkPrice();
    return cl != null && cl.ageMs < 15_000;
  }
}
