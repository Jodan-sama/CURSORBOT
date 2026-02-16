/**
 * B4 5-Minute BTC Bot — main runner.
 * Trades Polymarket btc-updown-5m markets using intra-window momentum signals.
 *
 * Loop: every 5 seconds, check timing → collect data → compute signals → place order.
 * Entry window: 90-150 seconds into the 5-min window (after seeing 2 min of price action).
 *
 * Features: bankroll persistence, 5-phase Kelly, order splitting, $1M auto-stop.
 */

import 'dotenv/config';
import { JsonRpcProvider, Contract } from 'ethers';
import { PriceFeed } from './price-feed.js';
import { computeSignals, type SignalOutput } from './signals.js';
import {
  createRiskState,
  restoreRiskState,
  serializeRiskState,
  shouldTrade,
  getConfidenceThreshold,
  getBetSize,
  getPhase,
  recordResult,
  getRiskSummary,
  isTargetReached,
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
  setEmergencyOff,
  logError,
  logPosition,
  loadB4State,
  saveB4State,
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

const ORDER_CHUNK_SIZE = 500; // split orders into ~$500 chunks
const CHUNK_DELAY_MS = 1_500; // 1.5s between chunks

/**
 * Place order on Polymarket. Splits into chunks if betSize > ORDER_CHUNK_SIZE.
 * Returns the first successful orderId.
 */
async function placePolyOrder(
  slug: string,
  side: 'yes' | 'no',
  totalSize: number,
): Promise<{ orderId?: string; skipReason?: string; chunksPlaced?: number; chunksFailed?: number }> {
  const { getPolyMarketBySlug } = await import('../polymarket/gamma.js');
  const {
    createPolyClobClient,
    getPolyClobConfigFromEnv,
    getOrCreateDerivedPolyClient,
    createAndPostPolyOrder,
    orderParamsFromParsedMarket,
  } = await import('../polymarket/clob.js');

  const market = await getPolyMarketBySlug(slug);
  if (!market) return { skipReason: `market not found: ${slug}` };

  // Calculate chunks: each chunk is ~ORDER_CHUNK_SIZE contracts
  const contractsTotal = Math.max(10, Math.round(totalSize / 0.50));
  const chunkContracts = Math.max(10, Math.round(ORDER_CHUNK_SIZE / 0.50));
  const numChunks = totalSize > ORDER_CHUNK_SIZE ? Math.ceil(contractsTotal / chunkContracts) : 1;
  const contractsPerChunk = numChunks === 1 ? contractsTotal : chunkContracts;

  let firstOrderId: string | undefined;
  let chunksPlaced = 0;
  let chunksFailed = 0;

  for (let i = 0; i < numChunks; i++) {
    const chunkSize = i === numChunks - 1 ? contractsTotal - contractsPerChunk * i : contractsPerChunk;
    if (chunkSize <= 0) break;

    try {
      const orderId = await withPolyProxy(async () => {
        const cfg = getPolyClobConfigFromEnv();
        const client = cfg != null
          ? createPolyClobClient(cfg)
          : await getOrCreateDerivedPolyClient();
        const price = 0.50;
        const params = orderParamsFromParsedMarket(market, price, chunkSize, side);
        const result = await createAndPostPolyOrder(client, params);
        return result.orderID ?? (result as Record<string, unknown>).orderId as string | undefined;
      });

      if (orderId) {
        if (!firstOrderId) firstOrderId = orderId;
        chunksPlaced++;
        if (numChunks > 1) console.log(`[B4] chunk ${i + 1}/${numChunks}: ${chunkSize} contracts | orderId=${orderId}`);
      } else {
        chunksFailed++;
      }
    } catch (e) {
      chunksFailed++;
      console.error(`[B4] chunk ${i + 1}/${numChunks} failed:`, e instanceof Error ? e.message : e);
    }

    // Delay between chunks to avoid rate limiting
    if (i < numChunks - 1) await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));
  }

  if (firstOrderId) return { orderId: firstOrderId, chunksPlaced, chunksFailed };
  return { skipReason: `all ${numChunks} chunks failed`, chunksFailed };
}

// ---------------------------------------------------------------------------
// Wallet balance (reads USDC on Polygon via RPC — no proxy, free)
// ---------------------------------------------------------------------------

const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'];

async function getWalletUsdcBalance(): Promise<number | null> {
  try {
    const rpc = process.env.POLYGON_RPC_URL;
    const funder = process.env.POLYMARKET_FUNDER;
    if (!rpc || !funder) return null;
    const provider = new JsonRpcProvider(rpc);
    const usdc = new Contract(USDC_POLYGON, ERC20_BALANCE_ABI, provider);
    const raw: bigint = await usdc.balanceOf(funder);
    return Number(raw) / 1e6; // USDC has 6 decimals
  } catch (e) {
    console.error('[B4] wallet balance read failed:', e instanceof Error ? e.message : e);
    return null;
  }
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
  betSize: number;
}

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
const PERSIST_INTERVAL_TICKS = 12; // persist state every ~60 seconds

async function runOneTick(
  feed: PriceFeed,
  risk: RiskState,
  windowState: WindowState,
  now: Date,
  tickCount: number,
): Promise<WindowState> {
  // -----------------------------------------------------------------------
  // $1M target check
  // -----------------------------------------------------------------------
  if (isTargetReached(risk)) {
    console.log(`[B4] TARGET REACHED: $${risk.bankroll.toFixed(2)} >= $1,000,000`);
    try {
      await setEmergencyOff(true);
      await logPosition({
        bot: 'B4',
        asset: 'BTC',
        venue: 'polymarket',
        strike_spread_pct: 0,
        position_size: 0,
        raw: { event: 'target_reached', bankroll: risk.bankroll },
      });
      await saveB4State(serializeRiskState(risk));
      await logError(new Error('B4 TARGET REACHED — $1M'), { bankroll: risk.bankroll, phase: getPhase(risk.bankroll) });
    } catch { /* best effort */ }
    process.exit(0);
  }

  // -----------------------------------------------------------------------
  // Emergency off check
  // -----------------------------------------------------------------------
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

  // -----------------------------------------------------------------------
  // New window? Resolve previous trade and reset.
  // -----------------------------------------------------------------------
  if (windowStartMs !== windowState.startMs) {
    if (windowState.direction && windowState.orderId && windowState.windowOpenPrice) {
      try {
        const spotNow = await feed.getSpotPrice();
        const wasUp = spotNow >= windowState.windowOpenPrice;
        const won = (windowState.direction === 'up' && wasUp) || (windowState.direction === 'down' && !wasUp);
        recordWindowOutcome(wasUp);
        recordResult(risk, won, windowState.betSize);
        console.log(`[B4] window resolved: bet ${windowState.direction}, outcome ${wasUp ? 'up' : 'down'}, ${won ? 'WIN' : 'LOSS'} | ${getRiskSummary(risk)}`);

        // Sync bankroll from actual wallet balance (1 free RPC call, no proxy)
        const walletBal = await getWalletUsdcBalance();
        if (walletBal != null && walletBal > 0) {
          const drift = Math.abs(walletBal - risk.bankroll);
          if (drift > 0.01) {
            console.log(`[B4] bankroll sync: internal $${risk.bankroll.toFixed(2)} → wallet $${walletBal.toFixed(2)} (drift $${drift.toFixed(2)})`);
            risk.bankroll = walletBal;
            if (walletBal > risk.maxBankroll) risk.maxBankroll = walletBal;
          }
        }

        try { await saveB4State(serializeRiskState(risk)); } catch { /* best effort */ }
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
      betSize: 0,
    };

    feed.setWindowOpen(windowStartMs);
  }

  // Refresh price data
  await feed.refresh();

  // Record window open price at ~5 seconds in
  if (windowState.windowOpenPrice == null && secIntoWindow >= 5) {
    windowState.windowOpenPrice = await feed.getWindowOpen();
    if (tickCount % 60 === 0) console.log(`[B4] window open: $${windowState.windowOpenPrice?.toFixed(2)} | slug: ${getPolySlug5m(now)}`);
  }

  // Periodic state persistence
  if (tickCount % PERSIST_INTERVAL_TICKS === 0) {
    try { await saveB4State(serializeRiskState(risk)); } catch { /* best effort */ }
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

  // Risk checks (includes drawdown, daily loss, circuit breaker, cooldown)
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

  const lastChangePct = recentOutcomes.length > 0 ? 0 : 0;
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

  // -----------------------------------------------------------------------
  // Place order (with splitting for large bets)
  // -----------------------------------------------------------------------
  const betSize = getBetSize(risk);
  const slug = getPolySlug5m(now);
  const side = signals.direction === 'up' ? 'yes' : 'no';
  const phase = getPhase(risk.bankroll);

  console.log(`[B4] SIGNAL: ${signals.direction} (composite=${signals.composite.toFixed(3)}) | bet $${betSize} (Phase ${phase}) | slug: ${slug}`);

  try {
    const result = await placePolyOrder(slug, side, betSize);
    if (result.orderId) {
      windowState.enteredThisWindow = true;
      windowState.orderId = result.orderId;
      windowState.direction = signals.direction;
      windowState.betSize = betSize;
      const chunkInfo = (result.chunksPlaced ?? 0) > 1 ? ` | ${result.chunksPlaced} chunks ok, ${result.chunksFailed ?? 0} failed` : '';
      console.log(`[B4] ORDER PLACED: ${side} $${betSize} @ ~50c | orderId=${result.orderId}${chunkInfo}`);
      try {
        await logPosition({
          bot: 'B4',
          asset: 'BTC',
          venue: 'polymarket',
          strike_spread_pct: signals.composite,
          position_size: betSize,
          ticker_or_slug: slug,
          order_id: result.orderId,
          raw: {
            direction: signals.direction,
            composite: signals.composite,
            intraWindow: signals.intraWindow,
            momentum: signals.momentum,
            volume: signals.volume,
            rsiSignal: signals.rsiSignal,
            trend: signals.trend,
            volatility: signals.volatility,
            phase: String(phase),
            bankroll: risk.bankroll,
            chunksPlaced: result.chunksPlaced,
            chunksFailed: result.chunksFailed,
          },
        });
      } catch { /* don't fail the trade on log error */ }
    } else {
      console.log(`[B4] order skip: ${result.skipReason}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[B4] order failed: ${msg}`);
    windowState.enteredThisWindow = true;
    try { await logError(e, { bot: 'B4', slug, side, betSize }); } catch { /* ignore */ }
  }

  return windowState;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function startB4Loop(): Promise<void> {
  // Load persisted state or fall back to initial bankroll
  let risk: RiskState;
  const saved = await loadB4State();
  if (saved && saved.bankroll > 0) {
    risk = restoreRiskState(saved);
    console.log(`[B4] Restored state: ${getRiskSummary(risk)}`);
  } else {
    risk = createRiskState(INITIAL_BANKROLL);
    console.log(`[B4] Fresh start: bankroll $${INITIAL_BANKROLL}`);
  }

  // Sync bankroll from actual wallet balance on startup
  const startupBal = await getWalletUsdcBalance();
  if (startupBal != null && startupBal > 0) {
    const drift = Math.abs(startupBal - risk.bankroll);
    if (drift > 0.01) {
      console.log(`[B4] startup wallet sync: $${risk.bankroll.toFixed(2)} → $${startupBal.toFixed(2)}`);
      risk.bankroll = startupBal;
      if (startupBal > risk.maxBankroll) risk.maxBankroll = startupBal;
      try { await saveB4State(serializeRiskState(risk)); } catch { /* best effort */ }
    }
  }

  const feed = new PriceFeed();
  let windowState: WindowState = {
    startMs: 0,
    enteredThisWindow: false,
    windowOpenPrice: null,
    signalResult: null,
    orderId: null,
    direction: null,
    betSize: 0,
  };
  let tickCount = 0;

  console.log(`[B4] Starting 5-minute BTC bot | ${getRiskSummary(risk)}`);
  console.log(`[B4] Strategy: intra-window momentum + multi-signal ensemble`);
  console.log(`[B4] Entry: 90-150s into each 5m window`);
  console.log(`[B4] Target: $1,000,000`);

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

  const shutdown = async () => {
    console.log(`[B4] shutting down | ${getRiskSummary(risk)}`);
    try { await saveB4State(serializeRiskState(risk)); } catch { /* best effort */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
