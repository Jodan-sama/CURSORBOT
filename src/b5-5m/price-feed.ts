/**
 * Live multi-asset price feed for B5 (ETH, SOL, XRP).
 *
 * Chainlink only via Polymarket RTDS — same 2-min retry then reset behaviour as B4.
 */

import WebSocket from 'ws';
import type { B5Asset } from './clock.js';

const RTDS_URL = 'wss://ws-live-data.polymarket.com';
const PING_INTERVAL_MS = 5_000;
const RECONNECT_DELAY_MS = 3_000;
const SILENT_RECONNECT_MS = 45_000;
const CHAINLINK_MAX_AGE_MS = 10_000;

const SYMBOL_MAP: Record<string, B5Asset> = {
  'eth/usd': 'ETH', 'sol/usd': 'SOL', 'xrp/usd': 'XRP',
};

const chainlinkPrices: Record<B5Asset, { price: number; ts: number }> = {
  ETH: { price: 0, ts: 0 }, SOL: { price: 0, ts: 0 }, XRP: { price: 0, ts: 0 },
};

let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let staleCheckTimer: ReturnType<typeof setInterval> | null = null;
let reconnecting = false;
let lastPriceMessageMs = 0;

function connectRTDS(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  reconnecting = false;
  try {
    ws = new WebSocket(RTDS_URL);
  } catch (e) {
    console.error('[B5 RTDS] WebSocket constructor failed:', e instanceof Error ? e.message : e);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    lastPriceMessageMs = Date.now();
    console.log('[B5 RTDS] connected to Polymarket Chainlink feed');
    ws!.send(JSON.stringify({
      action: 'subscribe',
      subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*' }],
    }));
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'ping' }));
    }, PING_INTERVAL_MS);
    if (staleCheckTimer) clearInterval(staleCheckTimer);
    staleCheckTimer = setInterval(() => {
      if (ws?.readyState !== WebSocket.OPEN || reconnecting) return;
      const elapsed = Date.now() - lastPriceMessageMs;
      if (elapsed > SILENT_RECONNECT_MS) {
        console.warn(`[B5 RTDS] no price update for ${Math.round(elapsed / 1000)}s — reconnecting`);
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
      if (msg.topic === 'crypto_prices_chainlink' && msg.payload?.symbol && msg.payload.value != null) {
        const asset = SYMBOL_MAP[msg.payload.symbol];
        if (asset) {
          lastPriceMessageMs = Date.now();
          chainlinkPrices[asset] = { price: msg.payload.value, ts: msg.payload.timestamp ?? Date.now() };
        }
      }
    } catch { /* ignore non-JSON pings/acks */ }
  });

  ws.on('close', () => {
    console.warn('[B5 RTDS] disconnected');
    scheduleReconnect();
  });

  ws.on('error', (err: Error) => {
    console.error('[B5 RTDS] error:', err.message);
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

export function getChainlinkPrice(asset: B5Asset): { price: number; ageMs: number } | null {
  const p = chainlinkPrices[asset];
  if (p == null || p.price <= 0) return null;
  return { price: p.price, ageMs: Date.now() - p.ts };
}

/** Retry Chainlink for this long after window start before giving up and allowing reset. */
export const CHAINLINK_RETRY_MS = 2 * 60_000;

export class PriceFeed {
  private windowOpenChainlink: Partial<Record<B5Asset, number>> = {};
  private currentWindowStart = 0;
  private didResetThisWindow = false;

  constructor() {
    connectRTDS();
  }

  setWindowOpen(windowStartMs: number): void {
    if (this.currentWindowStart === windowStartMs) return;
    this.currentWindowStart = windowStartMs;
    this.didResetThisWindow = false;
    const assets: B5Asset[] = ['ETH', 'SOL', 'XRP'];
    for (const asset of assets) {
      const cl = getChainlinkPrice(asset);
      if (cl && cl.ageMs < CHAINLINK_MAX_AGE_MS) {
        this.windowOpenChainlink[asset] = cl.price;
        console.log(`[B5 PriceFeed] ${asset} window open (Chainlink): $${cl.price.toFixed(4)} (age ${cl.ageMs}ms)`);
      } else {
        this.windowOpenChainlink[asset] = undefined;
        console.warn(`[B5 PriceFeed] ${asset} window open: Chainlink not ready (will retry up to 2 min, then reset)`);
      }
    }
  }

  async getWindowOpen(asset: B5Asset): Promise<number> {
    const stored = this.windowOpenChainlink[asset];
    if (stored != null && stored > 0) return stored;

    const elapsedSinceWindowStart = Date.now() - this.currentWindowStart;
    if (elapsedSinceWindowStart < CHAINLINK_RETRY_MS) {
      const cl = getChainlinkPrice(asset);
      if (cl && cl.ageMs < CHAINLINK_MAX_AGE_MS) {
        this.windowOpenChainlink[asset] = cl.price;
        console.log(`[B5 PriceFeed] ${asset} window open (Chainlink after retry): $${cl.price.toFixed(4)}`);
        return cl.price;
      }
    } else if (!this.didResetThisWindow) {
      this.didResetThisWindow = true;
      this.reset();
    }
    return 0;
  }

  async getSpotPrice(asset: B5Asset): Promise<number> {
    const cl = getChainlinkPrice(asset);
    if (cl && cl.ageMs < 15_000) return cl.price;
    return 0;
  }

  isChainlinkLive(asset: B5Asset): boolean {
    const cl = getChainlinkPrice(asset);
    return cl != null && cl.ageMs < 15_000;
  }

  reset(): void {
    this.windowOpenChainlink = {};
    this.currentWindowStart = 0;
    this.didResetThisWindow = true;
    console.log('[B5 PriceFeed] reset: cleared window state (no Chainlink for 2 min)');
  }
}
