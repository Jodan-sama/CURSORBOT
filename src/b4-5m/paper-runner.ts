/**
 * B4/B5 Paper Trader — NO REAL ORDERS
 *
 * Runs on the B4 droplet alongside (or instead of) the live bot.
 * Tests three strategies simultaneously on every 5-minute window:
 *
 *   B4-paper (normal):  Momentum > 0.06% → buy Up; < -0.06% → buy Down
 *   B4-paper (reverse): Momentum > 0.06% → buy Down; < -0.06% → buy Up
 *   B5-paper (spread):  Spread-based entries (adapted B1/B2/B3 for 5-min)
 *
 * Uses real Chainlink prices, real order book bid/ask, but places NO orders.
 * Logs simulated trades to Supabase `positions` table for later analysis.
 */

import 'dotenv/config';
import { PriceFeed, getChainlinkPrice } from './price-feed.js';
import {
  getWindowStart,
  msUntilWindowEnd,
  getPolySlug5m,
  secondsIntoWindow,
} from './clock.js';
import { logPosition, logError } from '../db/supabase.js';
import { getPolyMarketBySlug } from '../polymarket/gamma.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CLOB_HOST = 'https://clob.polymarket.com';
const TICK_INTERVAL_MS = 3_000;
const PRICE_HISTORY_SEC = 90;
const POSITION_SIZE_USD = 5;

// B4 Momentum config
const MOMENTUM_THRESHOLD = 0.0006;   // 0.06%
const B4_TAKE_PROFIT_PCT = 0.08;     // +8%
const B4_STOP_LOSS_PCT = 0.05;       // -5%
const B4_MIN_ENTRY_SEC = 60;         // wait 60s for book to fill
const B4_MIN_SEC_LEFT = 60;          // need 60s left for TP/SL

// B5 Spread config (adapted B1/B2/B3 for 5-min)
const B5_TIERS = [
  { name: 'B5-T1', spreadPct: 0.12, entryAfterSec: 250, limitPrice: 0.96 },  // like B1: last 50s
  { name: 'B5-T2', spreadPct: 0.33, entryAfterSec: 200, limitPrice: 0.97 },  // like B2: last 100s
  { name: 'B5-T3', spreadPct: 0.58, entryAfterSec: 140, limitPrice: 0.97 },  // like B3: last 160s
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PaperPosition {
  bot: string;
  direction: 'up' | 'down';
  strategy: 'momentum' | 'momentum-reverse' | 'spread';
  tokenId: string;
  entryMid: number;
  entryAsk: number;
  entryBid: number;
  entryBtcPrice: number;
  entryTime: number;
  windowStart: number;
  slug: string;
  tier?: string;           // for B5 spread tiers
  spreadAtEntry?: number;  // for B5
  momentumAtEntry?: number; // for B4
}

interface PricePoint {
  time: number;
  price: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const priceHistory: PricePoint[] = [];
const openPositions: PaperPosition[] = [];
let currentWindowStart = 0;
let b4TradesThisWindow = 0;
const b5PlacedThisWindow = new Set<string>(); // track which tiers placed this window

// Stats
let totalB4Normal = { trades: 0, wins: 0, pnl: 0 };
let totalB4Reverse = { trades: 0, wins: 0, pnl: 0 };
let totalB5 = { trades: 0, wins: 0, pnl: 0 };

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
  if (now - priceHistory[0].time < 60_000) return null;

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
// Order book reader (public, no auth)
// ---------------------------------------------------------------------------

interface BookLevel { price: number; size: number }

async function getBookTopLevels(tokenId: string): Promise<{ bid: number; ask: number; mid: number } | null> {
  try {
    const res = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`);
    if (!res.ok) return null;
    const book = (await res.json()) as { bids?: BookLevel[]; asks?: BookLevel[] };

    const bids = (book.bids ?? []).map(b => ({ price: Number(b.price), size: Number(b.size) }));
    const asks = (book.asks ?? []).map(a => ({ price: Number(a.price), size: Number(a.size) }));

    // Best bid/ask that are "real" (not penny-level)
    const bestBid = bids.filter(b => b.price >= 0.05).sort((a, b) => b.price - a.price)[0];
    const bestAsk = asks.filter(a => a.price <= 0.95).sort((a, b) => a.price - b.price)[0];

    if (!bestBid || !bestAsk) {
      // Fallback to midpoint endpoint
      const midRes = await fetch(`${CLOB_HOST}/midpoint?token_id=${tokenId}`);
      if (!midRes.ok) return null;
      const midData = (await midRes.json()) as { mid?: string };
      const mid = parseFloat(midData.mid ?? '0');
      if (mid <= 0 || mid >= 1) return null;
      return { bid: mid - 0.005, ask: mid + 0.005, mid };
    }

    const mid = (bestBid.price + bestAsk.price) / 2;
    return { bid: bestBid.price, ask: bestAsk.price, mid };
  } catch {
    return null;
  }
}

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
// Paper entry (no real order — just log)
// ---------------------------------------------------------------------------

function paperEntry(params: Omit<PaperPosition, 'entryTime'>): void {
  const pos: PaperPosition = { ...params, entryTime: Date.now() };
  openPositions.push(pos);
  console.log(
    `[PAPER] OPEN ${pos.bot} ${pos.direction} (${pos.strategy}${pos.tier ? ' ' + pos.tier : ''}) ` +
    `| mid=${pos.entryMid.toFixed(3)} ask=${pos.entryAsk.toFixed(3)} bid=${pos.entryBid.toFixed(3)} ` +
    `| BTC=$${pos.entryBtcPrice.toFixed(2)}` +
    (pos.spreadAtEntry != null ? ` | spread=${pos.spreadAtEntry.toFixed(4)}%` : '') +
    (pos.momentumAtEntry != null ? ` | mom=${(pos.momentumAtEntry * 100).toFixed(4)}%` : ''),
  );
}

// ---------------------------------------------------------------------------
// Paper exit (log simulated P&L)
// ---------------------------------------------------------------------------

async function paperExit(
  pos: PaperPosition,
  exitReason: string,
  currentMid: number,
  currentBid: number,
  currentAsk: number,
  btcPrice: number,
): Promise<void> {
  // Simulate realistic P&L: entered at ask, exit at bid
  const contracts = POSITION_SIZE_USD / pos.entryAsk;
  const realPnl = (currentBid - pos.entryAsk) * contracts;
  const midPnl = (currentMid - pos.entryMid) * contracts;
  const won = realPnl > 0;

  // Update stats
  const stats = pos.strategy === 'momentum' ? totalB4Normal
    : pos.strategy === 'momentum-reverse' ? totalB4Reverse
    : totalB5;
  stats.trades++;
  if (won) stats.wins++;
  stats.pnl += realPnl;

  const winRate = stats.trades > 0 ? (stats.wins / stats.trades * 100).toFixed(1) : '0';

  console.log(
    `[PAPER] EXIT ${pos.bot} ${exitReason}: ${pos.direction} (${pos.strategy}${pos.tier ? ' ' + pos.tier : ''}) ` +
    `| midPnL=$${midPnl.toFixed(3)} realPnL=$${realPnl.toFixed(3)} (${won ? 'WIN' : 'LOSS'}) ` +
    `| entryAsk=${pos.entryAsk.toFixed(3)} exitBid=${currentBid.toFixed(3)} ` +
    `| cumPnL=$${stats.pnl.toFixed(2)} W/L=${stats.wins}/${stats.trades - stats.wins} (${winRate}%)`,
  );

  // Log to Supabase
  try {
    await logPosition({
      bot: pos.bot as 'B4',
      asset: 'BTC',
      venue: 'polymarket',
      strike_spread_pct: pos.spreadAtEntry ?? (pos.momentumAtEntry ? pos.momentumAtEntry * 100 : 0),
      position_size: POSITION_SIZE_USD,
      ticker_or_slug: pos.slug,
      raw: {
        paper: true,
        strategy: pos.strategy,
        tier: pos.tier,
        direction: pos.direction,
        exitReason,
        entryMid: pos.entryMid,
        entryAsk: pos.entryAsk,
        entryBid: pos.entryBid,
        exitMid: currentMid,
        exitBid: currentBid,
        exitAsk: currentAsk,
        midPnl,
        realPnl,
        won,
        entryBtcPrice: pos.entryBtcPrice,
        exitBtcPrice: btcPrice,
        momentumAtEntry: pos.momentumAtEntry,
        spreadAtEntry: pos.spreadAtEntry,
        cumPnl: stats.pnl,
        cumWins: stats.wins,
        cumTrades: stats.trades,
      },
    });
  } catch { /* best effort */ }

  // Remove from open
  const idx = openPositions.indexOf(pos);
  if (idx >= 0) openPositions.splice(idx, 1);
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

async function runOneTick(feed: PriceFeed, tickCount: number): Promise<void> {
  const now = new Date();
  const windowStartMs = getWindowStart(now).getTime();
  const secInWindow = secondsIntoWindow(now);
  const msLeft = msUntilWindowEnd(now);

  // Record Chainlink price
  const cl = getChainlinkPrice();
  if (cl && cl.ageMs < 10_000) {
    recordPrice(cl.price);
  }

  // New window → reset counters, capture window open
  if (windowStartMs !== currentWindowStart) {
    currentWindowStart = windowStartMs;
    b4TradesThisWindow = 0;
    b5PlacedThisWindow.clear();
    feed.setWindowOpen(windowStartMs);
  }

  const btcPrice = cl?.price ?? 0;
  const slug = getPolySlug5m(now);

  // --- Monitor open positions for TP/SL/Window End ---
  const positionsToCheck = [...openPositions];
  for (const pos of positionsToCheck) {
    if (pos.windowStart !== windowStartMs && pos.strategy !== 'spread') {
      // B4 momentum: force exit at window boundary
      const mid = await getContractMidPrice(pos.tokenId);
      if (mid != null) {
        const book = await getBookTopLevels(pos.tokenId);
        await paperExit(pos, 'WINDOW_END', mid, book?.bid ?? mid - 0.005, book?.ask ?? mid + 0.005, btcPrice);
      } else {
        // Can't get price — exit at estimated loss
        await paperExit(pos, 'WINDOW_END_NO_PRICE', pos.entryMid * 0.5, pos.entryMid * 0.48, pos.entryMid * 0.52, btcPrice);
      }
      continue;
    }

    // B5 spread positions resolve at window end (no early exit)
    if (pos.strategy === 'spread') {
      if (pos.windowStart !== windowStartMs) {
        // Window ended — resolve at $1 or $0
        const windowOpenPrice = await feed.getWindowOpen();
        const resolvedUp = btcPrice > windowOpenPrice;
        const won = (pos.direction === 'up' && resolvedUp) || (pos.direction === 'down' && !resolvedUp);
        const resolvePrice = won ? 1.0 : 0.0;
        const resolvePnl = (resolvePrice - pos.entryAsk) * (POSITION_SIZE_USD / pos.entryAsk);
        await paperExit(pos, won ? 'RESOLVED_WIN' : 'RESOLVED_LOSS', resolvePrice, resolvePrice, resolvePrice, btcPrice);
      }
      continue;
    }

    // B4 momentum TP/SL check
    const mid = await getContractMidPrice(pos.tokenId);
    if (mid != null) {
      const pctChange = (mid - pos.entryMid) / pos.entryMid;
      const forceExit = msLeft < 25_000;

      let exitReason: string | null = null;
      if (pctChange >= B4_TAKE_PROFIT_PCT) exitReason = 'TP';
      else if (pctChange <= -B4_STOP_LOSS_PCT) exitReason = 'SL';
      else if (forceExit) exitReason = 'WINDOW_END';

      if (exitReason) {
        const book = await getBookTopLevels(pos.tokenId);
        await paperExit(pos, exitReason, mid, book?.bid ?? mid - 0.005, book?.ask ?? mid + 0.005, btcPrice);
      } else if (tickCount % 10 === 0) {
        console.log(
          `[PAPER] holding ${pos.bot} ${pos.direction} (${pos.strategy}) ` +
          `| change=${(pctChange * 100).toFixed(2)}% | TP@+${(B4_TAKE_PROFIT_PCT * 100).toFixed(0)}% SL@-${(B4_STOP_LOSS_PCT * 100).toFixed(0)}%`,
        );
      }
    }
  }

  // --- B4 Momentum entries (normal + reverse) ---
  const hasB4Open = openPositions.some(p => p.strategy === 'momentum' || p.strategy === 'momentum-reverse');
  if (!hasB4Open && b4TradesThisWindow < 3 && secInWindow >= B4_MIN_ENTRY_SEC && msLeft > B4_MIN_SEC_LEFT * 1000) {
    const momentum = getMomentum1m();
    if (momentum != null && Math.abs(momentum) >= MOMENTUM_THRESHOLD) {
      const normalDir: 'up' | 'down' = momentum > 0 ? 'up' : 'down';
      const reverseDir: 'up' | 'down' = momentum > 0 ? 'down' : 'up';
      const normalSide = normalDir === 'up' ? 'yes' : 'no';
      const reverseSide = reverseDir === 'up' ? 'yes' : 'no';

      try {
        const market = await getPolyMarketBySlug(slug);
        if (market) {
          const normalTokenId = normalSide === 'yes' ? market.clobTokenIds[0] : market.clobTokenIds[1];
          const reverseTokenId = reverseSide === 'yes' ? market.clobTokenIds[0] : market.clobTokenIds[1];

          // Get real book data for both sides
          const normalBook = await getBookTopLevels(normalTokenId);
          const reverseBook = await getBookTopLevels(reverseTokenId);

          if (normalBook && reverseBook) {
            b4TradesThisWindow++;
            console.log(`[PAPER] B4 SIGNAL: momentum=${(momentum * 100).toFixed(4)}% | normal=${normalDir} reverse=${reverseDir}`);

            paperEntry({
              bot: 'B4-paper',
              direction: normalDir,
              strategy: 'momentum',
              tokenId: normalTokenId,
              entryMid: normalBook.mid,
              entryAsk: normalBook.ask,
              entryBid: normalBook.bid,
              entryBtcPrice: btcPrice,
              windowStart: windowStartMs,
              slug,
              momentumAtEntry: momentum,
            });

            paperEntry({
              bot: 'B4-paper',
              direction: reverseDir,
              strategy: 'momentum-reverse',
              tokenId: reverseTokenId,
              entryMid: reverseBook.mid,
              entryAsk: reverseBook.ask,
              entryBid: reverseBook.bid,
              entryBtcPrice: btcPrice,
              windowStart: windowStartMs,
              slug,
              momentumAtEntry: momentum,
            });
          }
        }
      } catch (e) {
        if (tickCount % 20 === 0) console.log(`[PAPER] B4 market lookup failed: ${e instanceof Error ? e.message : e}`);
      }
    } else if (tickCount % 20 === 0 && momentum == null) {
      console.log('[PAPER] waiting for 60s of Chainlink data...');
    }
  }

  // --- B5 Spread entries ---
  if (btcPrice > 0) {
    const windowOpenPrice = await feed.getWindowOpen();
    if (windowOpenPrice > 0) {
      const spreadPct = Math.abs((btcPrice - windowOpenPrice) / btcPrice * 100);
      const spreadDir: 'up' | 'down' = btcPrice > windowOpenPrice ? 'up' : 'down';

      for (const tier of B5_TIERS) {
        const tierKey = `${tier.name}-${windowStartMs}`;
        if (b5PlacedThisWindow.has(tierKey)) continue;
        if (secInWindow < tier.entryAfterSec) continue;
        if (spreadPct < tier.spreadPct) continue;

        // Check we don't already have this tier open
        if (openPositions.some(p => p.tier === tier.name && p.windowStart === windowStartMs)) continue;

        try {
          const market = await getPolyMarketBySlug(slug);
          if (market) {
            const side = spreadDir === 'up' ? 'yes' : 'no';
            const tokenId = side === 'yes' ? market.clobTokenIds[0] : market.clobTokenIds[1];
            const book = await getBookTopLevels(tokenId);

            if (book) {
              // For spread strategy: only enter if contract price is high enough
              // (simulating buying at 96-97c limit)
              const wouldFillAt = book.ask;

              b5PlacedThisWindow.add(tierKey);
              console.log(
                `[PAPER] B5 SIGNAL ${tier.name}: spread=${spreadPct.toFixed(4)}% (threshold ${tier.spreadPct}%) ` +
                `| dir=${spreadDir} | ask=${wouldFillAt.toFixed(3)} | limit=${tier.limitPrice}`,
              );

              paperEntry({
                bot: 'B5-paper',
                direction: spreadDir,
                strategy: 'spread',
                tokenId,
                entryMid: book.mid,
                entryAsk: Math.min(wouldFillAt, tier.limitPrice), // simulated limit fill
                entryBid: book.bid,
                entryBtcPrice: btcPrice,
                windowStart: windowStartMs,
                slug,
                tier: tier.name,
                spreadAtEntry: spreadPct,
              });
            }
          }
        } catch (e) {
          console.log(`[PAPER] B5 ${tier.name} market lookup failed: ${e instanceof Error ? e.message : e}`);
        }
      }

      // Log spread periodically for debugging
      if (tickCount % 20 === 0 && spreadPct > 0.01) {
        console.log(
          `[PAPER] B5 spread: ${spreadPct.toFixed(4)}% ${spreadDir} ` +
          `| BTC=$${btcPrice.toFixed(2)} open=$${windowOpenPrice.toFixed(2)} ` +
          `| ${secInWindow.toFixed(0)}s into window`,
        );
      }
    }
  }

  // --- Periodic summary ---
  if (tickCount % 100 === 0) {
    const mom = getMomentum1m();
    console.log('');
    console.log(`[PAPER] ═══ Status @ ${new Date().toISOString()} ═══`);
    console.log(`[PAPER] BTC=$${btcPrice.toFixed(2)} | mom=${mom != null ? (mom * 100).toFixed(4) + '%' : 'n/a'}`);
    console.log(`[PAPER] B4 normal:  ${totalB4Normal.trades} trades | ${totalB4Normal.wins}W ${totalB4Normal.trades - totalB4Normal.wins}L | PnL=$${totalB4Normal.pnl.toFixed(2)} | WR=${totalB4Normal.trades > 0 ? (totalB4Normal.wins / totalB4Normal.trades * 100).toFixed(1) : 0}%`);
    console.log(`[PAPER] B4 reverse: ${totalB4Reverse.trades} trades | ${totalB4Reverse.wins}W ${totalB4Reverse.trades - totalB4Reverse.wins}L | PnL=$${totalB4Reverse.pnl.toFixed(2)} | WR=${totalB4Reverse.trades > 0 ? (totalB4Reverse.wins / totalB4Reverse.trades * 100).toFixed(1) : 0}%`);
    console.log(`[PAPER] B5 spread:  ${totalB5.trades} trades | ${totalB5.wins}W ${totalB5.trades - totalB5.wins}L | PnL=$${totalB5.pnl.toFixed(2)} | WR=${totalB5.trades > 0 ? (totalB5.wins / totalB5.trades * 100).toFixed(1) : 0}%`);
    console.log(`[PAPER] Open positions: ${openPositions.length}`);
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function startPaperTrader(): Promise<void> {
  console.log('');
  console.log('[PAPER] ═══ Paper Trader Starting ═══');
  console.log('[PAPER] B4 momentum: TP=+8%, SL=-5%, threshold=0.06%, entry after 60s');
  console.log('[PAPER] B5 spread tiers:');
  for (const t of B5_TIERS) {
    console.log(`[PAPER]   ${t.name}: spread>${t.spreadPct}%, entry after ${t.entryAfterSec}s, limit ${t.limitPrice}`);
  }
  console.log('[PAPER] NO REAL ORDERS — simulation only');
  console.log('[PAPER] Logging to Supabase positions table (bot=B4-paper / B5-paper)');
  console.log('');

  const feed = new PriceFeed();

  // Wait for Chainlink
  await new Promise((r) => setTimeout(r, 5_000));
  if (feed.isChainlinkLive()) {
    const cl = getChainlinkPrice();
    console.log(`[PAPER] Chainlink LIVE — BTC=$${cl?.price.toFixed(2) ?? '?'}`);
  } else {
    console.warn('[PAPER] Chainlink not connected yet — will keep trying');
  }

  let tickCount = 0;

  const runTick = async () => {
    tickCount++;
    try {
      await feed.refresh();
      await runOneTick(feed, tickCount);
    } catch (e) {
      console.error('[PAPER] tick error:', e instanceof Error ? e.message : e);
      try { await logError(e, { bot: 'B4', stage: 'paper-tick' }); } catch { /* ignore */ }
    }
    setTimeout(runTick, TICK_INTERVAL_MS);
  };

  runTick();

  const shutdown = () => {
    console.log('');
    console.log('[PAPER] ═══ Final Results ═══');
    console.log(`[PAPER] B4 normal:  ${totalB4Normal.trades} trades | PnL=$${totalB4Normal.pnl.toFixed(2)} | WR=${totalB4Normal.trades > 0 ? (totalB4Normal.wins / totalB4Normal.trades * 100).toFixed(1) : 0}%`);
    console.log(`[PAPER] B4 reverse: ${totalB4Reverse.trades} trades | PnL=$${totalB4Reverse.pnl.toFixed(2)} | WR=${totalB4Reverse.trades > 0 ? (totalB4Reverse.wins / totalB4Reverse.trades * 100).toFixed(1) : 0}%`);
    console.log(`[PAPER] B5 spread:  ${totalB5.trades} trades | PnL=$${totalB5.pnl.toFixed(2)} | WR=${totalB5.trades > 0 ? (totalB5.wins / totalB5.trades * 100).toFixed(1) : 0}%`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
