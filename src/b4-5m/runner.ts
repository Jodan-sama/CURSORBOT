/**
 * B4 5-Minute BTC Momentum Scalper — v2
 *
 * Strategy:
 *   Entry:  1-minute BTC momentum > 0.03%  → buy Up contracts
 *           1-minute BTC momentum < -0.03% → buy Down contracts
 *   Size:   $5 per trade (fixed)
 *   Exit:   +3% take profit OR -5% stop loss on contract price (early close)
 *   Limit:  Max 3 trades per 5-minute window, 1 open position at a time
 *   Poll:   Every 3 seconds
 *   Price:  Chainlink BTC/USD via Polymarket RTDS WebSocket (same oracle as resolution)
 *
 * Orders are placed via Polymarket CLOB through the HTTP proxy.
 * Contract mid-price monitoring uses the public CLOB endpoint (no auth).
 */

import 'dotenv/config';
import { PriceFeed, getChainlinkPrice } from './price-feed.js';
import {
  getWindowStart,
  msUntilWindowEnd,
  getPolySlug5m,
  secondsIntoWindow,
} from './clock.js';
import {
  isEmergencyOff,
  logError,
  logPosition,
  loadB4State,
  saveB4State,
} from '../db/supabase.js';
import {
  createPolyClobClient,
  getPolyClobConfigFromEnv,
  getOrCreateDerivedPolyClient,
} from '../polymarket/clob.js';
import { getPolyMarketBySlug } from '../polymarket/gamma.js';
import {
  Side,
  OrderType,
  type ClobClient,
  type UserOrder,
  type CreateOrderOptions,
} from '@polymarket/clob-client';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const POSITION_SIZE_USD = parseFloat(process.env.B4_POSITION_SIZE || '5');
const MAX_TRADES_PER_WINDOW = 3;
const MOMENTUM_THRESHOLD = 0.0003;   // 0.03%
const TAKE_PROFIT_PCT = 0.03;        // +3% contract price
const STOP_LOSS_PCT = 0.05;          // -5% contract price
const TICK_INTERVAL_MS = 3_000;      // 3 seconds
const FORCED_EXIT_SEC = 25;          // force-exit this many seconds before window end
const MIN_ENTRY_SEC_LEFT = 60;       // need at least 60s left for entry
const PRICE_HISTORY_SEC = 90;        // keep 90s of Chainlink prices
const CLOB_HOST = 'https://clob.polymarket.com';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Position {
  direction: 'up' | 'down';
  tokenId: string;
  entryContractPrice: number;
  contracts: number;
  entryBtcPrice: number;
  entryTime: number;
  windowStart: number;
  orderId: string;
  slug: string;
  negRisk: boolean;
  tickSize: CreateOrderOptions['tickSize'];
}

interface PricePoint {
  time: number;
  price: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let bankroll = 0;
let peakBankroll = 0;
let totalTrades = 0;
let totalWins = 0;
let totalLosses = 0;
const priceHistory: PricePoint[] = [];
let openPosition: Position | null = null;
let tradesThisWindow = 0;
let currentWindowStart = 0;

// ---------------------------------------------------------------------------
// Chainlink price history → momentum
// ---------------------------------------------------------------------------

function recordPrice(price: number): void {
  const now = Date.now();
  priceHistory.push({ time: now, price });
  const cutoff = now - PRICE_HISTORY_SEC * 1000;
  while (priceHistory.length > 0 && priceHistory[0].time < cutoff) {
    priceHistory.shift();
  }
}

function getMomentum1m(): number | null {
  if (priceHistory.length < 2) return null;
  const now = Date.now();
  if (now - priceHistory[0].time < 60_000) return null; // need 60s of data

  const target = now - 60_000;
  let closest = priceHistory[0];
  for (const p of priceHistory) {
    if (Math.abs(p.time - target) < Math.abs(closest.time - target)) {
      closest = p;
    }
  }

  const current = priceHistory[priceHistory.length - 1];
  return (current.price - closest.price) / closest.price;
}

// ---------------------------------------------------------------------------
// Contract mid-price (public CLOB endpoint — no auth, no proxy)
// ---------------------------------------------------------------------------

async function getContractMidPrice(tokenId: string): Promise<number | null> {
  try {
    const res = await fetch(`${CLOB_HOST}/midpoint?token_id=${tokenId}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { mid?: string };
    const mid = parseFloat(data.mid ?? '0');
    return mid > 0 && mid < 1 ? mid : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Proxy wrapper (for order placement only)
// ---------------------------------------------------------------------------

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

async function getClobClient(): Promise<ClobClient> {
  const cfg = getPolyClobConfigFromEnv();
  return cfg != null ? createPolyClobClient(cfg) : await getOrCreateDerivedPolyClient();
}

// ---------------------------------------------------------------------------
// Buy contracts
// ---------------------------------------------------------------------------

interface TradeResult {
  orderId?: string;
  tokenId?: string;
  contractPrice?: number;
  contracts?: number;
  negRisk?: boolean;
  tickSize?: CreateOrderOptions['tickSize'];
  error?: string;
}

async function buyContracts(slug: string, side: 'yes' | 'no'): Promise<TradeResult> {
  try {
    return await withPolyProxy(async () => {
      const market = await getPolyMarketBySlug(slug);
      if (!market) return { error: `Market not found: ${slug}` };

      const tokenId = side === 'yes' ? market.clobTokenIds[0] : market.clobTokenIds[1];
      if (!tokenId) return { error: `No ${side} token for ${slug}` };

      const client = await getClobClient();

      // Get current mid-price for entry
      const midRaw = await client.getMidpoint(tokenId);
      const mid = parseFloat(typeof midRaw === 'string' ? midRaw : (midRaw as { mid?: string })?.mid ?? '0');
      if (mid <= 0.05 || mid >= 0.95) return { error: `Mid-price out of range: ${mid}` };

      const tickSize: CreateOrderOptions['tickSize'] =
        (market.orderPriceMinTickSize ? String(market.orderPriceMinTickSize) : '0.01') as CreateOrderOptions['tickSize'];
      const tickVal = parseFloat(tickSize);

      // Buy slightly above mid (cross the spread for immediate fill)
      const buyPrice = Math.min(
        Math.round((mid + tickVal * 2) / tickVal) * tickVal,
        0.99,
      );
      const contracts = Math.max(1, Math.floor(POSITION_SIZE_USD / buyPrice));

      const userOrder: UserOrder = {
        tokenID: tokenId,
        price: Number(buyPrice.toFixed(4)),
        size: contracts,
        side: Side.BUY,
      };

      console.log(`[B4] BUY ${side} ${contracts}x @ ${buyPrice.toFixed(3)} (mid=${mid.toFixed(3)}) | ${slug}`);

      const result = await client.createAndPostOrder(
        userOrder,
        { tickSize, negRisk: market.negRisk ?? false },
        OrderType.GTC,
      );

      const orderId = (result as { orderID?: string; orderId?: string })?.orderID
        ?? (result as { orderId?: string })?.orderId;
      if (!orderId) return { error: `No orderId: ${JSON.stringify(result)}` };

      return {
        orderId,
        tokenId,
        contractPrice: buyPrice,
        contracts,
        negRisk: market.negRisk ?? false,
        tickSize,
      };
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Sell contracts (early exit)
// ---------------------------------------------------------------------------

async function sellContracts(pos: Position): Promise<{ orderId?: string; sellPrice?: number; error?: string }> {
  try {
    return await withPolyProxy(async () => {
      const client = await getClobClient();

      // Get current mid to place aggressive sell
      const midRaw = await client.getMidpoint(pos.tokenId);
      const mid = parseFloat(typeof midRaw === 'string' ? midRaw : (midRaw as { mid?: string })?.mid ?? '0');
      const tickVal = parseFloat(pos.tickSize);

      // Sell slightly below mid for immediate fill
      const sellPrice = Math.max(
        Math.round((mid - tickVal * 2) / tickVal) * tickVal,
        tickVal,
      );

      const userOrder: UserOrder = {
        tokenID: pos.tokenId,
        price: Number(sellPrice.toFixed(4)),
        size: pos.contracts,
        side: Side.SELL,
      };

      console.log(`[B4] SELL ${pos.contracts}x @ ${sellPrice.toFixed(3)} (mid=${mid.toFixed(3)})`);

      const result = await client.createAndPostOrder(
        userOrder,
        { tickSize: pos.tickSize, negRisk: pos.negRisk },
        OrderType.GTC,
      );

      const orderId = (result as { orderID?: string; orderId?: string })?.orderID
        ?? (result as { orderId?: string })?.orderId;
      return { orderId: orderId ?? undefined, sellPrice };
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

async function runOneTick(feed: PriceFeed, tickCount: number): Promise<void> {
  const now = new Date();
  const windowStartMs = getWindowStart(now).getTime();
  const secInWindow = secondsIntoWindow(now);
  const msLeft = msUntilWindowEnd(now);

  // --- Record Chainlink price ---
  const cl = getChainlinkPrice();
  if (cl && cl.ageMs < 10_000) {
    recordPrice(cl.price);
  }

  // --- New window → reset trade count ---
  if (windowStartMs !== currentWindowStart) {
    currentWindowStart = windowStartMs;
    tradesThisWindow = 0;
  }

  // --- Emergency off check (every ~30s) ---
  if (tickCount % 10 === 0) {
    try {
      if (await isEmergencyOff()) {
        if (tickCount % 100 === 0) console.log('[B4] emergency off — paused');
        return;
      }
    } catch { /* Supabase may not be configured */ }
  }

  // --- Monitor open position for TP / SL / forced exit ---
  if (openPosition) {
    const mid = await getContractMidPrice(openPosition.tokenId);
    if (mid != null) {
      const pctChange = (mid - openPosition.entryContractPrice) / openPosition.entryContractPrice;
      const forceExit = msLeft < FORCED_EXIT_SEC * 1000;

      let exitReason: string | null = null;
      if (pctChange >= TAKE_PROFIT_PCT) exitReason = 'TP';
      else if (pctChange <= -STOP_LOSS_PCT) exitReason = 'SL';
      else if (forceExit) exitReason = 'WINDOW_END';

      if (exitReason) {
        const sellResult = await sellContracts(openPosition);
        const exitPrice = sellResult.sellPrice ?? mid;
        const pnl = (exitPrice - openPosition.entryContractPrice) * openPosition.contracts;
        const won = pnl > 0;

        bankroll += pnl;
        if (bankroll > peakBankroll) peakBankroll = bankroll;
        totalTrades++;
        if (won) totalWins++;
        else totalLosses++;

        console.log(
          `[B4] EXIT ${exitReason}: ${openPosition.direction} ` +
          `| entry=${openPosition.entryContractPrice.toFixed(3)} exit=${exitPrice.toFixed(3)} ` +
          `| change=${(pctChange * 100).toFixed(2)}% ` +
          `| PnL=$${pnl.toFixed(3)} (${won ? 'WIN' : 'LOSS'}) ` +
          `| bankroll=$${bankroll.toFixed(2)} W/L=${totalWins}/${totalLosses}`,
        );

        if (sellResult.error) {
          console.error(`[B4] sell error (position may still be open): ${sellResult.error}`);
        }

        // Log to Supabase
        try {
          await logPosition({
            bot: 'B4',
            asset: 'BTC',
            venue: 'polymarket',
            strike_spread_pct: pctChange * 100,
            position_size: POSITION_SIZE_USD,
            ticker_or_slug: openPosition.slug,
            order_id: sellResult.orderId ?? openPosition.orderId,
            raw: {
              direction: openPosition.direction,
              exitReason,
              entryContractPrice: openPosition.entryContractPrice,
              exitContractPrice: exitPrice,
              contracts: openPosition.contracts,
              pnl,
              bankroll,
              entryBtcPrice: openPosition.entryBtcPrice,
              exitBtcPrice: cl?.price ?? 0,
            },
          });
        } catch { /* best effort */ }

        // Persist state
        try {
          await saveB4State({
            bankroll,
            max_bankroll: peakBankroll,
            consecutive_losses: won ? 0 : (totalLosses - totalWins),
            cooldown_until_ms: 0,
            results_json: [],
            daily_start_bankroll: bankroll,
            daily_start_date: '',
            half_kelly_trades_left: 0,
          });
        } catch { /* best effort */ }

        openPosition = null;
      } else if (tickCount % 10 === 0) {
        // Periodic position status log
        console.log(
          `[B4] holding ${openPosition.direction} ` +
          `| entry=${openPosition.entryContractPrice.toFixed(3)} mid=${mid.toFixed(3)} ` +
          `| change=${(pctChange * 100).toFixed(2)}% ` +
          `| TP@+${(TAKE_PROFIT_PCT * 100).toFixed(0)}% SL@-${(STOP_LOSS_PCT * 100).toFixed(0)}%`,
        );
      }
    }
    return; // don't enter while holding a position
  }

  // --- Entry checks ---
  if (tradesThisWindow >= MAX_TRADES_PER_WINDOW) return;
  if (bankroll < POSITION_SIZE_USD) {
    if (tickCount % 100 === 0) console.log(`[B4] bankroll $${bankroll.toFixed(2)} < $${POSITION_SIZE_USD} — cannot trade`);
    return;
  }
  if (msLeft < MIN_ENTRY_SEC_LEFT * 1000) return; // not enough time for TP/SL
  if (secInWindow < 15) return; // let the window settle for ~15s

  // --- Momentum signal ---
  const momentum = getMomentum1m();
  if (momentum == null) {
    if (tickCount % 20 === 0) console.log('[B4] waiting for 60s of Chainlink data...');
    return;
  }

  if (Math.abs(momentum) < MOMENTUM_THRESHOLD) return; // no signal

  const direction: 'up' | 'down' = momentum > 0 ? 'up' : 'down';
  const side: 'yes' | 'no' = direction === 'up' ? 'yes' : 'no';
  const slug = getPolySlug5m(now);

  console.log(`[B4] SIGNAL: ${direction} | momentum=${(momentum * 100).toFixed(4)}% | slug=${slug}`);

  const result = await buyContracts(slug, side);

  if (result.orderId && result.tokenId && result.contractPrice && result.contracts) {
    openPosition = {
      direction,
      tokenId: result.tokenId,
      entryContractPrice: result.contractPrice,
      contracts: result.contracts,
      entryBtcPrice: cl?.price ?? 0,
      entryTime: Date.now(),
      windowStart: windowStartMs,
      orderId: result.orderId,
      slug,
      negRisk: result.negRisk ?? false,
      tickSize: result.tickSize ?? '0.01',
    };
    tradesThisWindow++;
    console.log(
      `[B4] OPENED: ${direction} ${result.contracts}x @ ${result.contractPrice.toFixed(3)} ` +
      `| trades=${tradesThisWindow}/${MAX_TRADES_PER_WINDOW} | bankroll=$${bankroll.toFixed(2)}`,
    );
  } else {
    console.log(`[B4] order failed: ${result.error}`);
    try { await logError(new Error(result.error ?? 'order failed'), { bot: 'B4', slug, side }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function startB4Loop(): Promise<void> {
  // Load persisted state
  const saved = await loadB4State();
  if (saved && saved.bankroll > 0) {
    bankroll = saved.bankroll;
    peakBankroll = saved.max_bankroll;
    console.log(`[B4] Restored: bankroll=$${bankroll.toFixed(2)} peak=$${peakBankroll.toFixed(2)}`);
  } else {
    bankroll = parseFloat(process.env.B4_INITIAL_BANKROLL || '10');
    peakBankroll = bankroll;
    console.log(`[B4] Fresh start: bankroll=$${bankroll.toFixed(2)}`);
  }

  const feed = new PriceFeed();

  // Wait for Chainlink WebSocket to connect
  await new Promise((r) => setTimeout(r, 5_000));
  if (feed.isChainlinkLive()) {
    const cl = getChainlinkPrice();
    console.log(`[B4] Chainlink LIVE — BTC=$${cl?.price.toFixed(2) ?? '?'}`);
  } else {
    console.warn('[B4] Chainlink not connected yet — will keep trying');
  }

  let tickCount = 0;

  console.log('');
  console.log('[B4] ═══ Momentum Scalper v2 ═══');
  console.log(`[B4] Position size: $${POSITION_SIZE_USD}`);
  console.log(`[B4] Max trades/window: ${MAX_TRADES_PER_WINDOW}`);
  console.log(`[B4] Take profit: +${(TAKE_PROFIT_PCT * 100).toFixed(0)}% | Stop loss: -${(STOP_LOSS_PCT * 100).toFixed(0)}%`);
  console.log(`[B4] Momentum threshold: ${(MOMENTUM_THRESHOLD * 100).toFixed(2)}%`);
  console.log(`[B4] Bankroll: $${bankroll.toFixed(2)}`);
  console.log('');

  const runTick = async () => {
    tickCount++;

    if (tickCount % 100 === 0) {
      const cl = getChainlinkPrice();
      const mom = getMomentum1m();
      console.log(
        `[B4] alive | ${new Date().toISOString()} ` +
        `| BTC=$${cl?.price.toFixed(2) ?? '?'} ` +
        `| mom=${mom != null ? (mom * 100).toFixed(4) + '%' : 'n/a'} ` +
        `| bankroll=$${bankroll.toFixed(2)} W/L=${totalWins}/${totalLosses} ` +
        `| pos=${openPosition ? openPosition.direction : 'none'}`,
      );
    }

    try {
      await feed.refresh();
      await runOneTick(feed, tickCount);
    } catch (e) {
      console.error('[B4] tick error:', e instanceof Error ? e.message : e);
      try { await logError(e, { bot: 'B4', stage: 'tick' }); } catch { /* ignore */ }
    }

    setTimeout(runTick, TICK_INTERVAL_MS);
  };

  runTick();

  const shutdown = async () => {
    console.log(`[B4] shutting down | bankroll=$${bankroll.toFixed(2)} W/L=${totalWins}/${totalLosses}`);
    try {
      await saveB4State({
        bankroll,
        max_bankroll: peakBankroll,
        consecutive_losses: 0,
        cooldown_until_ms: 0,
        results_json: [],
        daily_start_bankroll: bankroll,
        daily_start_date: '',
        half_kelly_trades_left: 0,
      });
    } catch { /* best effort */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
