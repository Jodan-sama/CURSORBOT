/**
 * Live price feed for B4.
 *
 * Chainlink only (via Polymarket RTDS) — real-time BTC/USD price that Polymarket
 * uses to resolve 5-minute markets. No Binance fallback; if Chainlink is unavailable
 * we skip all bots and retry; after 2 minutes we reset.
 */

import WebSocket from 'ws';

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
let staleCheckTimer: ReturnType<typeof setInterval> | null = null;
let reconnecting = false;
/** Last time we received a price update. If no update for this long, connection is "silent" — force reconnect. */
let lastPriceMessageMs = 0;
const SILENT_RECONNECT_MS = 45_000;

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
    lastPriceMessageMs = Date.now();
    console.log('[RTDS] connected to Polymarket Chainlink feed');
    ws!.send(JSON.stringify({
      action: 'subscribe',
      subscriptions: [{
        topic: 'crypto_prices_chainlink',
        type: '*',
        filters: '{"symbol":"btc/usd"}',
      }],
    }));
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'ping' }));
      }
    }, PING_INTERVAL_MS);
    if (staleCheckTimer) clearInterval(staleCheckTimer);
    staleCheckTimer = setInterval(() => {
      if (ws?.readyState !== WebSocket.OPEN || reconnecting) return;
      const elapsed = Date.now() - lastPriceMessageMs;
      if (elapsed > SILENT_RECONNECT_MS) {
        console.warn(`[RTDS] no price update for ${Math.round(elapsed / 1000)}s — reconnecting`);
        try { ws.close(); } catch { /* ignore */ }
      }
    }, 10_000);
  });

  ws.on('message', (raw: WebSocket.Data) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        topic?: string;
        payload?: { symbol?: string; value?: number; timestamp?: number };
      };
      if (msg.topic === 'crypto_prices_chainlink' && msg.payload?.symbol === 'btc/usd' && msg.payload.value) {
        lastPriceMessageMs = Date.now();
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
  if (staleCheckTimer) { clearInterval(staleCheckTimer); staleCheckTimer = null; }
  ws = null;
  setTimeout(connectRTDS, RECONNECT_DELAY_MS);
}

/** Get the latest Chainlink BTC/USD price (the oracle Polymarket uses). */
export function getChainlinkPrice(): { price: number; ageMs: number } | null {
  if (chainlinkPrice == null) return null;
  return { price: chainlinkPrice, ageMs: Date.now() - chainlinkTimestamp };
}

// ---------------------------------------------------------------------------
// PriceFeed class (Chainlink only; no Binance fallback)
// ---------------------------------------------------------------------------

/** Retry Chainlink for this long after window start before giving up and allowing reset. */
export const CHAINLINK_RETRY_MS = 2 * 60_000; // 2 minutes

const CHAINLINK_MAX_AGE_MS = 10_000;

export class PriceFeed {
  /** Chainlink price captured at the window boundary. */
  private windowOpenChainlink: number | null = null;
  private currentWindowStart = 0;
  private didResetThisWindow = false;

  constructor() {
    connectRTDS();
  }

  /** No-op for API compatibility (Binance candles removed; other runners may still call this). */
  async refresh(): Promise<void> {}

  /**
   * Record the window open price from Chainlink at the window boundary.
   * If Chainlink not ready, leave null so getWindowOpen() retries for up to 2 min.
   */
  setWindowOpen(windowStartMs: number): void {
    if (this.currentWindowStart === windowStartMs) return;
    this.currentWindowStart = windowStartMs;
    this.didResetThisWindow = false;

    const cl = getChainlinkPrice();
    if (cl && cl.ageMs < CHAINLINK_MAX_AGE_MS) {
      this.windowOpenChainlink = cl.price;
      console.log(`[PriceFeed] window open (Chainlink): $${cl.price.toFixed(2)} (age ${cl.ageMs}ms)`);
    } else {
      this.windowOpenChainlink = null;
      console.warn(`[PriceFeed] window open: Chainlink not ready (will retry up to 2 min, then reset)`);
    }
  }

  /** Get the window open price. Chainlink only; retries for 2 min, then returns 0 (caller should reset). */
  async getWindowOpen(): Promise<number> {
    if (this.windowOpenChainlink != null) return this.windowOpenChainlink;

    const elapsedSinceWindowStart = Date.now() - this.currentWindowStart;
    if (elapsedSinceWindowStart < CHAINLINK_RETRY_MS) {
      const cl = getChainlinkPrice();
      if (cl && cl.ageMs < CHAINLINK_MAX_AGE_MS) {
        this.windowOpenChainlink = cl.price;
        console.log(`[PriceFeed] window open (Chainlink after retry): $${cl.price.toFixed(2)}`);
        return cl.price;
      }
    } else if (!this.didResetThisWindow) {
      // No Chainlink for 2 min — reset once so we can try again next window
      this.didResetThisWindow = true;
      this.reset();
    }
    return 0;
  }

  /** Current spot price — Chainlink only. If stale, returns 0 (skip bots). */
  async getSpotPrice(): Promise<number> {
    const cl = getChainlinkPrice();
    if (cl && cl.ageMs < 15_000) return cl.price;
    return 0;
  }

  /** Is the Chainlink feed connected and fresh? */
  isChainlinkLive(): boolean {
    const cl = getChainlinkPrice();
    return cl != null && cl.ageMs < 15_000;
  }

  /**
   * Reset window state after 2 min without Chainlink so we can try again next window.
   * Call after getWindowOpen() has returned 0 for 2 min.
   */
  reset(): void {
    this.windowOpenChainlink = null;
    this.currentWindowStart = 0;
    this.didResetThisWindow = true;
    console.log('[PriceFeed] reset: cleared window state (no Chainlink for 2 min)');
  }
}
