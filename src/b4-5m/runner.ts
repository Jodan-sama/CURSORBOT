/**
 * B4 5-Minute BTC Bot — main runner.
 * Trades Polymarket btc-updown-5m markets using intra-window momentum signals.
 *
 * Loop: every 5 seconds, check timing → collect data → compute signals → place order.
 * Entry window: 90-150 seconds into the 5-min window (after seeing 2 min of price action).
 */

import 'dotenv/config';
import { PriceFeed } from './price-feed.js';
import { computeSignals, type SignalOutput } from './signals.js';
import {
  createRiskState,
  shouldTrade,
  getConfidenceThreshold,
  getBetSize,
  recordResult,
  getRiskSummary,
  type RiskState,
} from './risk.js';
import {
  getWindowStart,
  getWindowEnd,
  secondsIntoWindow,
  isEntryWindow,
  getPolySlug5m,
  getWindowStartUnix,
} from './clock.js';
import {
  isEmergencyOff,
  logError,
} from '../db/supabase.js';
import type { Candle1m } from './download-candles.js';

// ---------------------------------------------------------------------------
// Polymarket 5m order placement (uses existing CLOB infrastructure + proxy)
// ---------------------------------------------------------------------------

/** Wrap fn with HTTP proxy for Polymarket CLOB calls (axios + undici). */
async function withPolyProxy<T>(fn: () => Promise<T>): Promise<T> {
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '';
  if (!proxy) return fn();
  const axios = (await import('axios')).default;
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  const prevUndici = (await import('undici')).getGlobalDispatcher();
  const { setGlobalDispatcher, ProxyAgent } = await import('undici');
  const prevAxiosAgent = axios.defaults.httpsAgent;
  const prevAxiosProxy = axios.defaults.proxy;
  try {
    setGlobalDispatcher(new ProxyAgent(proxy));
    axios.defaults.httpsAgent = new HttpsProxyAgent(proxy);
    axios.defaults.proxy = false;
    return await fn();
  } finally {
    setGlobalDispatcher(prevUndici);
    axios.defaults.httpsAgent = prevAxiosAgent;
    axios.defaults.proxy = prevAxiosProxy;
  }
}

async function placePolyOrder(
  slug: string,
  side: 'yes' | 'no',
  size: number,
): Promise<{ orderId?: string; skipReason?: string }> {
  const { getPolyMarketBySlug } = await import('../polymarket/gamma.js');
  const {
    createPolyClobClient,
    getPolyClobConfigFromEnv,
    getOrCreateDerivedPolyClient,
    createAndPostPolyOrder,
    orderParamsFromParsedMarket,
  } = await import('../polymarket/clob.js');

  // Gamma API (market lookup) runs direct — only CLOB (order placement) uses proxy
  const market = await getPolyMarketBySlug(slug);
  if (!market) return { skipReason: `market not found: ${slug}` };

  return withPolyProxy(async () => {
    const cfg = getPolyClobConfigFromEnv();
    const client = cfg != null
      ? createPolyClobClient(cfg)
      : await getOrCreateDerivedPolyClient();

    const price = 0.50;
    const params = orderParamsFromParsedMarket(market, price, size, side);

    const result = await createAndPostPolyOrder(client, params);
    const orderId = result.orderID ?? (result as Record<string, unknown>).orderId as string | undefined;
    return { orderId };
  });
}

// ---------------------------------------------------------------------------
// Window state tracking
// ---------------------------------------------------------------------------

interface WindowState {
  startMs: number;
  enteredThisWindow: boolean;
  windowOpenPrice: number | null;
  signalResult: SignalOutput | null;
  orderId: string | null;
  direction: 'up' | 'down' | null;
}

// Track last 10 window outcomes for trend signal
const recentOutcomes: boolean[] = [];

function recordWindowOutcome(outcome: boolean): void {
  recentOutcomes.push(outcome);
  if (recentOutcomes.length > 10) recentOutcomes.shift();
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

const TICK_INTERVAL_MS = 5_000;
const INITIAL_BANKROLL = parseFloat(process.env.B4_INITIAL_BANKROLL || '30');

async function runOneTick(
  feed: PriceFeed,
  risk: RiskState,
  windowState: WindowState,
  now: Date,
  tickCount: number,
): Promise<WindowState> {
  // Check emergency off
  if (tickCount % 12 === 0) {
    try {
      if (await isEmergencyOff()) {
        if (tickCount % 60 === 0) console.log('[B4] emergency off — paused');
        return windowState;
      }
    } catch {
      // Supabase might not be configured; continue
    }
  }

  const windowStartMs = getWindowStart(now).getTime();
  const secIntoWindow = secondsIntoWindow(now);

  // New window? Reset state.
  if (windowStartMs !== windowState.startMs) {
    // If we had a trade in the previous window, check outcome
    if (windowState.direction && windowState.orderId && windowState.windowOpenPrice) {
      try {
        const spotNow = await feed.getSpotPrice();
        const wasUp = spotNow >= windowState.windowOpenPrice;
        const won = (windowState.direction === 'up' && wasUp) || (windowState.direction === 'down' && !wasUp);
        recordWindowOutcome(wasUp);
        const betSize = getBetSize(risk);
        recordResult(risk, won, betSize);
        console.log(`[B4] window resolved: bet ${windowState.direction}, outcome ${wasUp ? 'up' : 'down'}, ${won ? 'WIN' : 'LOSS'} | ${getRiskSummary(risk)}`);
      } catch (e) {
        console.error('[B4] outcome check failed:', e instanceof Error ? e.message : e);
      }
    }

    windowState = {
      startMs: windowStartMs,
      enteredThisWindow: false,
      windowOpenPrice: null,
      signalResult: null,
      orderId: null,
      direction: null,
    };

    // Set window open price
    feed.setWindowOpen(windowStartMs);
  }

  // Refresh price data
  await feed.refresh();

  // Record window open price at ~5 seconds in
  if (windowState.windowOpenPrice == null && secIntoWindow >= 5) {
    windowState.windowOpenPrice = await feed.getWindowOpen();
    if (tickCount % 60 === 0) console.log(`[B4] window open: $${windowState.windowOpenPrice?.toFixed(2)} | slug: ${getPolySlug5m(now)}`);
  }

  // Already traded this window? Skip.
  if (windowState.enteredThisWindow) return windowState;

  // Not in entry window yet? (90-150 seconds in)
  if (!isEntryWindow(now)) {
    if (tickCount % 60 === 0 && secIntoWindow < 90) {
      console.log(`[B4] waiting for entry window (${secIntoWindow.toFixed(0)}s / 90-150s)`);
    }
    return windowState;
  }

  // Risk checks
  const { ok, reason } = shouldTrade(risk, now);
  if (!ok) {
    if (tickCount % 12 === 0) console.log(`[B4] skip: ${reason}`);
    return windowState;
  }

  // Compute signals
  const priorCandles = feed.getCandlesBefore(windowStartMs, 20);
  const intraCandles = feed.getCandlesInRange(windowStartMs, windowStartMs + 2 * 60 * 1000);
  const windowOpen = windowState.windowOpenPrice ?? 0;

  if (priorCandles.length < 10 || windowOpen === 0) {
    if (tickCount % 12 === 0) console.log(`[B4] not enough data: ${priorCandles.length} prior candles, open=$${windowOpen}`);
    return windowState;
  }

  const lastChangePct = recentOutcomes.length > 0 ? 0 : 0; // Simplified; the signal engine handles trends
  const signals = computeSignals({
    priorCandles,
    intraCandles,
    windowOpen,
    lastWindowOutcomes: recentOutcomes.slice(-3),
    lastWindowChangePct: lastChangePct,
  });

  windowState.signalResult = signals;

  if (signals.direction === 'skip') {
    if (tickCount % 12 === 0) console.log(`[B4] skip: composite ${signals.composite.toFixed(3)} (below threshold)`);
    return windowState;
  }

  const threshold = getConfidenceThreshold(risk);
  if (Math.abs(signals.composite) < threshold) {
    if (tickCount % 12 === 0) console.log(`[B4] skip: |${signals.composite.toFixed(3)}| < ${threshold}`);
    return windowState;
  }

  // Place order
  const betSize = getBetSize(risk);
  const slug = getPolySlug5m(now);
  const side = signals.direction === 'up' ? 'yes' : 'no';
  const contracts = Math.max(10, Math.round(betSize / 0.50)); // at ~50c each

  console.log(`[B4] SIGNAL: ${signals.direction} (composite=${signals.composite.toFixed(3)}) | bet $${betSize} (${contracts} contracts) | slug: ${slug}`);

  try {
    const result = await placePolyOrder(slug, side, contracts);
    if (result.orderId) {
      windowState.enteredThisWindow = true;
      windowState.orderId = result.orderId;
      windowState.direction = signals.direction;
      console.log(`[B4] ORDER PLACED: ${side} ${contracts}x @ ~50c | orderId=${result.orderId}`);
    } else {
      console.log(`[B4] order skip: ${result.skipReason}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[B4] order failed: ${msg}`);
    try { await logError(e, { bot: 'B4', slug, side, contracts }); } catch { /* ignore */ }
  }

  return windowState;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export function startB4Loop(): void {
  const feed = new PriceFeed();
  const risk = createRiskState(INITIAL_BANKROLL);
  let windowState: WindowState = {
    startMs: 0,
    enteredThisWindow: false,
    windowOpenPrice: null,
    signalResult: null,
    orderId: null,
    direction: null,
  };
  let tickCount = 0;

  console.log(`[B4] Starting 5-minute BTC bot | bankroll: $${INITIAL_BANKROLL}`);
  console.log(`[B4] Strategy: intra-window momentum + multi-signal ensemble`);
  console.log(`[B4] Entry: 90-150s into each 5m window`);

  const runTick = async () => {
    tickCount++;
    const now = new Date();

    if (tickCount % 60 === 0) {
      console.log(`[B4] alive | ${now.toISOString()} | ${getRiskSummary(risk)}`);
    }

    try {
      windowState = await runOneTick(feed, risk, windowState, now, tickCount);
    } catch (e) {
      console.error('[B4] tick error:', e instanceof Error ? e.message : e);
      try { await logError(e, { bot: 'B4', stage: 'tick' }); } catch { /* ignore */ }
    }

    setTimeout(runTick, TICK_INTERVAL_MS);
  };

  runTick();

  const shutdown = () => {
    console.log(`[B4] shutting down | ${getRiskSummary(risk)}`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
