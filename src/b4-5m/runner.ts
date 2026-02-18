/**
 * B4 5-Minute BTC Momentum Scalper — v2
 *
 * Strategy:
 *   Entry:  1-minute BTC momentum > 0.06%  → buy Up contracts
 *           1-minute BTC momentum < -0.06% → buy Down contracts
 *   Size:   $5 per trade (fixed, configurable via B4_POSITION_SIZE env)
 *   Exit:   +8% take profit OR -5% stop loss on contract price (early close)
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
  isB4EmergencyOff,
  logError,
  logPosition,
  loadB4State,
  saveB4State,
  saveB4OpenPosition,
  loadB4OpenPosition,
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
  type CreateOrderOptions,
} from '@polymarket/clob-client';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const POSITION_SIZE_USD = parseFloat(process.env.B4_POSITION_SIZE || '5');
const MAX_TRADES_PER_WINDOW = 3;
const MOMENTUM_THRESHOLD = 0.0006;   // 0.06% — filters noise, needs real directional move
const TAKE_PROFIT_PCT = 0.08;        // +8% contract price — nets ~6% after spread
const STOP_LOSS_PCT = 0.05;          // -5% contract price — wider to avoid noise stops
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
  entryMid: number;       // mid-price at entry (baseline for TP/SL)
  contracts: number;
  /** Actual shares filled at entry (from balance after buy). Used for position_size in logs so losses show correct size. */
  actualSharesBought?: number;
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
  entryMid?: number;      // mid at time of entry (baseline for TP/SL)
  contracts?: number;
  negRisk?: boolean;
  tickSize?: CreateOrderOptions['tickSize'];
  error?: string;
}

function parseMid(raw: unknown): number {
  if (typeof raw === 'string') return parseFloat(raw);
  if (typeof raw === 'number') return raw;
  if (raw && typeof raw === 'object' && 'mid' in raw) return parseFloat(String((raw as { mid: string }).mid));
  return 0;
}

async function buyContracts(slug: string, side: 'yes' | 'no'): Promise<TradeResult> {
  try {
    return await withPolyProxy(async () => {
      const market = await getPolyMarketBySlug(slug);
      if (!market) return { error: `Market not found: ${slug}` };

      const tokenId = side === 'yes' ? market.clobTokenIds[0] : market.clobTokenIds[1];
      if (!tokenId) return { error: `No ${side} token for ${slug}` };

      const client = await getClobClient();

      // Get current mid-price — this becomes the TP/SL baseline
      const mid = parseMid(await client.getMidpoint(tokenId));
      if (mid <= 0.05 || mid >= 0.95) return { error: `Mid-price out of range: ${mid}` };

      const tickSize: CreateOrderOptions['tickSize'] =
        (market.orderPriceMinTickSize ? String(market.orderPriceMinTickSize) : '0.01') as CreateOrderOptions['tickSize'];

      // FOK market order: fills immediately at best available price, or fails entirely
      const contracts = Math.max(1, Math.floor(POSITION_SIZE_USD / mid));

      console.log(`[B4] BUY ${side} $${POSITION_SIZE_USD} (mid=${mid.toFixed(3)}, ~${contracts} contracts) | ${slug}`);

      const result = await client.createAndPostMarketOrder(
        { tokenID: tokenId, amount: POSITION_SIZE_USD, side: Side.BUY },
        { tickSize, negRisk: market.negRisk ?? false },
        OrderType.FOK,
      );

      const orderId = (result as { orderID?: string; orderId?: string })?.orderID
        ?? (result as { orderId?: string })?.orderId;
      if (!orderId) return { error: `No fill (FOK rejected): ${JSON.stringify(result)}` };

      // Query actual balance after fill so we log correct position size (especially for losses)
      let actualSharesBought: number | undefined;
      try {
        const bal = await client.getBalanceAllowance({
          asset_type: 'CONDITIONAL' as unknown as import('@polymarket/clob-client').AssetType,
          token_id: tokenId,
        });
        const rawBalance = parseFloat(bal.balance);
        if (rawBalance > 0) {
          actualSharesBought = rawBalance > 1000 ? rawBalance / 1e6 : rawBalance;
          if (actualSharesBought !== contracts) {
            console.log(`[B4] entry fill: ${actualSharesBought.toFixed(6)} shares (requested ~${contracts})`);
          }
        }
      } catch {
        // optional: fall back to contracts estimate when logging
      }

      return {
        orderId,
        tokenId,
        entryMid: mid,
        contracts,
        actualSharesBought,
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

async function sellContracts(pos: Position): Promise<{ orderId?: string; actualSharesSold?: number; error?: string }> {
  try {
    return await withPolyProxy(async () => {
      const client = await getClobClient();

      // Query actual token balance so we sell EVERYTHING (not the rounded estimate)
      // getBalanceAllowance returns raw atomic units (10^6), divide to get shares
      let sellAmount = pos.contracts;
      try {
        const bal = await client.getBalanceAllowance({
          asset_type: 'CONDITIONAL' as unknown as import('@polymarket/clob-client').AssetType,
          token_id: pos.tokenId,
        });
        const rawBalance = parseFloat(bal.balance);
        if (rawBalance > 0) {
          // Balance is in atomic units (6 decimals like USDC); convert to shares
          const actualShares = rawBalance > 1000 ? rawBalance / 1e6 : rawBalance;
          sellAmount = actualShares;
          if (actualShares !== pos.contracts) {
            console.log(`[B4] token balance: raw=${rawBalance} shares=${actualShares.toFixed(6)} (estimated: ${pos.contracts})`);
          }
        }
      } catch {
        // Fall back to estimated contracts if balance query fails
      }

      console.log(`[B4] SELL ${sellAmount.toFixed(6)} shares (FOK market) | ${pos.tokenId.slice(0, 20)}…`);

      const result = await client.createAndPostMarketOrder(
        { tokenID: pos.tokenId, amount: sellAmount, side: Side.SELL },
        { tickSize: pos.tickSize, negRisk: pos.negRisk },
        OrderType.FOK,
      );

      const orderId = (result as { orderID?: string; orderId?: string })?.orderID
        ?? (result as { orderId?: string })?.orderId;
      if (!orderId) return { error: `Sell FOK rejected: ${JSON.stringify(result)}` };
      return { orderId, actualSharesSold: sellAmount };
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

  // --- B4-specific emergency off check (every ~30s) ---
  if (tickCount % 10 === 0) {
    try {
      if (await isB4EmergencyOff()) {
        if (tickCount % 100 === 0) console.log('[B4] emergency off — paused');
        return;
      }
    } catch { /* Supabase may not be configured */ }
  }

  // --- Monitor open position for TP / SL / forced exit ---
  if (openPosition) {
    const mid = await getContractMidPrice(openPosition.tokenId);
    if (mid != null) {
      // Compare mid-to-mid (entry mid vs current mid) for TP/SL
      const pctChange = (mid - openPosition.entryMid) / openPosition.entryMid;
      const forceExit = msLeft < FORCED_EXIT_SEC * 1000;

      let exitReason: string | null = null;
      if (pctChange >= TAKE_PROFIT_PCT) exitReason = 'TP';
      else if (pctChange <= -STOP_LOSS_PCT) exitReason = 'SL';
      else if (forceExit) exitReason = 'WINDOW_END';

      if (exitReason) {
        const sellResult = await sellContracts(openPosition);

        if (sellResult.error) {
          // Sell failed — position is still open, don't update bankroll
          console.error(`[B4] SELL FAILED (${exitReason}): ${sellResult.error} — will retry next tick`);
          // If we're at forced exit and sell fails, abandon tracking (let contract resolve)
          if (forceExit) {
            console.warn(`[B4] forced exit sell failed — contract will resolve at window end`);
            openPosition = null;
            try { await saveB4OpenPosition(null); } catch { /* best effort */ }
          }
          return;
        }

        // Use actual shares at entry for position_size (so losses show correct size even when we don't sell)
        const sharesAtEntry = openPosition.actualSharesBought ?? openPosition.contracts;
        const actualPositionSizeUsd = sharesAtEntry * openPosition.entryMid;

        // Sell succeeded — record P&L based on mid movement
        const pnl = (mid - openPosition.entryMid) * openPosition.contracts;
        const won = pnl > 0;

        bankroll += pnl;
        if (bankroll > peakBankroll) peakBankroll = bankroll;
        totalTrades++;
        if (won) totalWins++;
        else totalLosses++;

        console.log(
          `[B4] EXIT ${exitReason}: ${openPosition.direction} ` +
          `| entryMid=${openPosition.entryMid.toFixed(3)} currentMid=${mid.toFixed(3)} ` +
          `| change=${(pctChange * 100).toFixed(2)}% ` +
          `| PnL=$${pnl.toFixed(3)} (${won ? 'WIN' : 'LOSS'}) ` +
          `| bankroll=$${bankroll.toFixed(2)} W/L=${totalWins}/${totalLosses}`,
        );

        // Log to Supabase with actual position size (partial fills show correct size on dashboard)
        try {
          await logPosition({
            bot: 'B4',
            asset: 'BTC',
            venue: 'polymarket',
            strike_spread_pct: pctChange * 100,
            position_size: actualPositionSizeUsd,
            ticker_or_slug: openPosition.slug,
            order_id: sellResult.orderId ?? openPosition.orderId,
            raw: {
              direction: openPosition.direction,
              exitReason,
              entryMid: openPosition.entryMid,
              exitMid: mid,
              contracts: openPosition.contracts,
              actualSharesBought: openPosition.actualSharesBought,
              actualSharesSold: sellResult.actualSharesSold,
              pnl,
              bankroll,
              entryBtcPrice: openPosition.entryBtcPrice,
              exitBtcPrice: cl?.price ?? 0,
            },
          });
        } catch { /* best effort */ }

        // Persist state & clear saved position
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
          await saveB4OpenPosition(null);
        } catch { /* best effort */ }

        openPosition = null;
      } else if (tickCount % 10 === 0) {
        console.log(
          `[B4] holding ${openPosition.direction} ` +
          `| entryMid=${openPosition.entryMid.toFixed(3)} currentMid=${mid.toFixed(3)} ` +
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
  if (secInWindow < 60) return; // wait 60s for order book to fill out (spread is too wide early)

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

  if (result.orderId && result.tokenId && result.entryMid && result.contracts) {
    openPosition = {
      direction,
      tokenId: result.tokenId,
      entryMid: result.entryMid,
      contracts: result.contracts,
      actualSharesBought: result.actualSharesBought,
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
      `[B4] OPENED: ${direction} ~${result.contracts}x | entryMid=${result.entryMid.toFixed(3)} ` +
      `| trades=${tradesThisWindow}/${MAX_TRADES_PER_WINDOW} | bankroll=$${bankroll.toFixed(2)}`,
    );

    // Persist open position to Supabase so it survives restarts
    try {
      await saveB4OpenPosition(openPosition as unknown as Record<string, unknown>);
      console.log('[B4] position persisted to Supabase');
    } catch { /* best effort */ }
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

  // Restore persisted open position (survives restarts)
  try {
    const savedPos = await loadB4OpenPosition();
    if (savedPos && savedPos.tokenId && savedPos.entryMid) {
      openPosition = {
        direction: String(savedPos.direction) as 'up' | 'down',
        tokenId: String(savedPos.tokenId),
        entryMid: Number(savedPos.entryMid),
        contracts: Number(savedPos.contracts),
        entryBtcPrice: Number(savedPos.entryBtcPrice ?? 0),
        entryTime: Number(savedPos.entryTime ?? Date.now()),
        windowStart: Number(savedPos.windowStart ?? 0),
        orderId: String(savedPos.orderId ?? ''),
        slug: String(savedPos.slug ?? ''),
        negRisk: Boolean(savedPos.negRisk),
        tickSize: (String(savedPos.tickSize ?? '0.01')) as Position['tickSize'],
      };
      console.log(
        `[B4] RESTORED open position: ${openPosition.direction} ` +
        `| entryMid=${openPosition.entryMid.toFixed(3)} ` +
        `| contracts=${openPosition.contracts} ` +
        `| slug=${openPosition.slug}`,
      );
    }
  } catch (e) {
    console.warn('[B4] could not restore open position:', e instanceof Error ? e.message : e);
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

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // prevent double shutdown
    shuttingDown = true;
    console.log(`[B4] shutting down | bankroll=$${bankroll.toFixed(2)} W/L=${totalWins}/${totalLosses}`);

    // Attempt to sell open position before exiting
    if (openPosition) {
      console.log(`[B4] selling open position before shutdown: ${openPosition.direction} ${openPosition.contracts}x`);
      try {
        const sellResult = await sellContracts(openPosition);
        if (sellResult.orderId) {
          const mid = await getContractMidPrice(openPosition.tokenId);
          const pnl = mid ? (mid - openPosition.entryMid) * openPosition.contracts : 0;
          bankroll += pnl;
          if (bankroll > peakBankroll) peakBankroll = bankroll;
          totalTrades++;
          if (pnl > 0) totalWins++; else totalLosses++;
          console.log(`[B4] pre-shutdown sell OK | PnL=$${pnl.toFixed(3)} | bankroll=$${bankroll.toFixed(2)}`);
          openPosition = null;
          try { await saveB4OpenPosition(null); } catch { /* best effort */ }
        } else {
          console.warn(`[B4] pre-shutdown sell FAILED: ${sellResult.error} — position persisted for next restart`);
          // Position stays persisted in Supabase, next startup will pick it up
        }
      } catch (e) {
        console.warn('[B4] pre-shutdown sell error:', e instanceof Error ? e.message : e);
      }
    }

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
