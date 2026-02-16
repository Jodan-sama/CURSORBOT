/**
 * Backtesting simulator for B4 5-minute BTC strategy.
 * Downloads historical data, runs signal engine over every 5-min window,
 * simulates Kelly-sized betting from $30, and reports statistics.
 *
 * Usage: npx tsx src/b4-5m/backtest.ts [--days 90]
 */

import { downloadCandles, type Candle1m } from './download-candles.js';
import { computeSignals, HIGH_CONFIDENCE_THRESHOLD, COMPOSITE_THRESHOLD } from './signals.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Window5m {
  startMs: number;
  endMs: number;
  openPrice: number;
  closePrice: number;
  outcome: 'up' | 'down';
  changePct: number;
  candles: Candle1m[];
}

interface TradeResult {
  windowStart: number;
  direction: 'up' | 'down';
  outcome: 'up' | 'down';
  won: boolean;
  betSize: number;
  bankrollBefore: number;
  bankrollAfter: number;
  composite: number;
}

interface BacktestResult {
  totalWindows: number;
  tradesPlaced: number;
  wins: number;
  losses: number;
  winRate: number;
  finalBankroll: number;
  maxBankroll: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  ruinCount: number;
  trades: TradeResult[];
}

// ---------------------------------------------------------------------------
// Build 5-min windows from 1-min candles
// ---------------------------------------------------------------------------

function buildWindows(candles: Candle1m[]): Window5m[] {
  const WINDOW_MS = 5 * 60 * 1000;
  const byWindow = new Map<number, Candle1m[]>();

  for (const c of candles) {
    const windowStart = c.openTime - (c.openTime % WINDOW_MS);
    let arr = byWindow.get(windowStart);
    if (!arr) {
      arr = [];
      byWindow.set(windowStart, arr);
    }
    arr.push(c);
  }

  const windows: Window5m[] = [];
  const sortedKeys = [...byWindow.keys()].sort((a, b) => a - b);
  for (const key of sortedKeys) {
    const wCandles = byWindow.get(key)!;
    if (wCandles.length < 4) continue;
    wCandles.sort((a, b) => a.openTime - b.openTime);
    const openPrice = wCandles[0].open;
    const closePrice = wCandles[wCandles.length - 1].close;
    const changePct = ((closePrice - openPrice) / openPrice) * 100;
    windows.push({
      startMs: key,
      endMs: key + WINDOW_MS,
      openPrice,
      closePrice,
      outcome: closePrice >= openPrice ? 'up' : 'down',
      changePct,
      candles: wCandles,
    });
  }
  return windows;
}

// ---------------------------------------------------------------------------
// Kelly sizing
// ---------------------------------------------------------------------------

const MIN_BET = 5;
const INITIAL_BANKROLL = 30;

function kellyBet(bankroll: number, winRate: number, phase: number): number {
  if (bankroll < MIN_BET) return 0;
  if (phase === 1) return MIN_BET;

  const cap = phase === 2 ? 0.15 : 0.10;
  const f = Math.max(0, 2 * winRate - 1);
  const fraction = Math.min(f, cap);
  const bet = Math.max(MIN_BET, Math.floor(bankroll * fraction));
  return Math.min(bet, bankroll);
}

function getPhase(bankroll: number): number {
  if (bankroll < 200) return 1;
  if (bankroll < 5000) return 2;
  return 3;
}

// ---------------------------------------------------------------------------
// Single backtest run
// ---------------------------------------------------------------------------

export function runBacktest(
  candles: Candle1m[],
  options: {
    startBankroll?: number;
    startPct?: number;
    endPct?: number;
  } = {},
): BacktestResult {
  const windows = buildWindows(candles);
  const startBankroll = options.startBankroll ?? INITIAL_BANKROLL;
  const startIdx = Math.floor((options.startPct ?? 0) * windows.length);
  const endIdx = Math.floor((options.endPct ?? 1) * windows.length);

  let bankroll = startBankroll;
  let maxBankroll = bankroll;
  let maxDrawdownPct = 0;
  let wins = 0;
  let losses = 0;
  const trades: TradeResult[] = [];
  const returns: number[] = [];
  const recentResults: boolean[] = [];
  let consecutiveLosses = 0;
  let cooldownUntil = 0;

  function rollingWinRate(): number {
    if (recentResults.length < 10) return 0.52;
    const recent = recentResults.slice(-50);
    return recent.filter((w) => w).length / recent.length;
  }

  const LOOKBACK = 6;

  for (let i = Math.max(startIdx, LOOKBACK); i < endIdx; i++) {
    if (bankroll < MIN_BET) break;

    const window = windows[i];

    // Cooldown: after 5 consecutive losses, skip 3 windows
    if (i < cooldownUntil) continue;

    // Gather prior candles for signals (last 20 1-min candles before this window)
    const priorCandles: Candle1m[] = [];
    for (let j = i - 1; j >= 0 && priorCandles.length < 20; j--) {
      const wc = windows[j].candles;
      for (let k = wc.length - 1; k >= 0 && priorCandles.length < 20; k--) {
        priorCandles.unshift(wc[k]);
      }
    }

    // Intra-window: first 2 candles of current window (simulate entering at ~2 min mark)
    const intraCandles = window.candles.slice(0, 2);

    // Last 3 window outcomes
    const lastOutcomes: boolean[] = [];
    for (let j = Math.max(0, i - 3); j < i; j++) {
      lastOutcomes.push(windows[j].outcome === 'up');
    }
    const lastChangePct = i > 0 ? windows[i - 1].changePct : 0;

    const signals = computeSignals({
      priorCandles,
      intraCandles,
      windowOpen: window.openPrice,
      lastWindowOutcomes: lastOutcomes,
      lastWindowChangePct: lastChangePct,
    });

    if (signals.direction === 'skip') continue;

    // Phase-aware threshold
    const phase = getPhase(bankroll);
    const threshold = phase === 1 ? HIGH_CONFIDENCE_THRESHOLD : COMPOSITE_THRESHOLD;
    if (Math.abs(signals.composite) < threshold) continue;

    // Drawdown check
    if (bankroll < maxBankroll * 0.5 && bankroll < 200) continue;

    const wr = rollingWinRate();
    const betSize = wr < 0.45 ? MIN_BET : kellyBet(bankroll, wr, phase);
    if (betSize === 0 || betSize > bankroll) continue;

    const won = signals.direction === window.outcome;
    const bankrollBefore = bankroll;

    if (won) {
      bankroll += betSize;
      wins++;
      consecutiveLosses = 0;
    } else {
      bankroll -= betSize;
      losses++;
      consecutiveLosses++;
      if (consecutiveLosses >= 5) {
        cooldownUntil = i + 3;
        consecutiveLosses = 0;
      }
    }

    recentResults.push(won);
    returns.push(won ? betSize / bankrollBefore : -betSize / bankrollBefore);

    if (bankroll > maxBankroll) maxBankroll = bankroll;
    const drawdown = maxBankroll > 0 ? (maxBankroll - bankroll) / maxBankroll * 100 : 0;
    if (drawdown > maxDrawdownPct) maxDrawdownPct = drawdown;

    trades.push({
      windowStart: window.startMs,
      direction: signals.direction,
      outcome: window.outcome,
      won,
      betSize,
      bankrollBefore,
      bankrollAfter: bankroll,
      composite: signals.composite,
    });
  }

  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdReturn = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1))
    : 1;
  const tradesPerYear = 288 * 365;
  const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(tradesPerYear) : 0;

  return {
    totalWindows: endIdx - Math.max(startIdx, LOOKBACK),
    tradesPlaced: trades.length,
    wins,
    losses,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    finalBankroll: bankroll,
    maxBankroll,
    maxDrawdownPct,
    sharpeRatio,
    ruinCount: bankroll < MIN_BET ? 1 : 0,
    trades,
  };
}

// ---------------------------------------------------------------------------
// Monte Carlo
// ---------------------------------------------------------------------------

export function monteCarlo(
  candles: Candle1m[],
  runs: number,
  splitPct: number = 0.67,
): { median: BacktestResult; ruinProbability: number; avgWinRate: number; avgFinal: number } {
  const results: BacktestResult[] = [];
  let ruinCount = 0;

  for (let r = 0; r < runs; r++) {
    const noisyCandles = candles.map((c) => ({
      ...c,
      close: c.close * (1 + (Math.random() - 0.5) * 0.0002),
      takerBuyVolume: c.takerBuyVolume * (1 + (Math.random() - 0.5) * 0.05),
    }));

    const result = runBacktest(noisyCandles, { startPct: splitPct });
    results.push(result);
    if (result.ruinCount > 0) ruinCount++;
  }

  results.sort((a, b) => a.finalBankroll - b.finalBankroll);
  const median = results[Math.floor(results.length / 2)];
  const avgWinRate = results.reduce((s, r) => s + r.winRate, 0) / results.length;
  const avgFinal = results.reduce((s, r) => s + r.finalBankroll, 0) / results.length;

  return { median, ruinProbability: ruinCount / runs, avgWinRate, avgFinal };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const daysArg = process.argv.indexOf('--days');
  const days = daysArg >= 0 ? parseInt(process.argv[daysArg + 1], 10) : 90;

  console.log(`\n=== B4 5-Minute BTC Backtest (v2: intra-window signals) ===\n`);
  const candles = await downloadCandles(days);
  console.log(`Loaded ${candles.length} 1m candles (${days} days)\n`);

  const inSample = runBacktest(candles, { endPct: 0.67 });
  console.log(`--- In-Sample (first 67%) ---`);
  printResult(inSample);

  const outSample = runBacktest(candles, { startPct: 0.67 });
  console.log(`\n--- Out-of-Sample (last 33%) ---`);
  printResult(outSample);

  console.log(`\n--- Monte Carlo (500 runs, out-of-sample) ---`);
  const mc = monteCarlo(candles, 500);
  console.log(`  Median final bankroll: $${mc.median.finalBankroll.toFixed(2)}`);
  console.log(`  Average win rate:      ${(mc.avgWinRate * 100).toFixed(1)}%`);
  console.log(`  Average final:         $${mc.avgFinal.toFixed(2)}`);
  console.log(`  Ruin probability:      ${(mc.ruinProbability * 100).toFixed(1)}%`);
  console.log(`  Median trades placed:  ${mc.median.tradesPlaced}`);
  console.log(`  Median max drawdown:   ${mc.median.maxDrawdownPct.toFixed(1)}%`);

  console.log(`\n--- Edge Assessment ---`);
  const edgeOk = outSample.winRate > 0.52;
  console.log(`  Out-of-sample win rate: ${(outSample.winRate * 100).toFixed(1)}%`);
  console.log(`  Edge > 52%: ${edgeOk ? 'YES — proceed to live' : 'NO — refine further'}`);
  console.log(`  MC avg win rate:        ${(mc.avgWinRate * 100).toFixed(1)}%`);
  console.log(`  Recommendation: ${mc.avgWinRate > 0.52 && edgeOk ? 'DEPLOY' : 'ITERATE'}`);
}

function printResult(r: BacktestResult) {
  console.log(`  Windows:      ${r.totalWindows}`);
  console.log(`  Trades:       ${r.tradesPlaced}`);
  console.log(`  Wins:         ${r.wins} (${(r.winRate * 100).toFixed(1)}%)`);
  console.log(`  Losses:       ${r.losses}`);
  console.log(`  Final $:      $${r.finalBankroll.toFixed(2)}`);
  console.log(`  Max $:        $${r.maxBankroll.toFixed(2)}`);
  console.log(`  Max DD:       ${r.maxDrawdownPct.toFixed(1)}%`);
  console.log(`  Sharpe:       ${r.sharpeRatio.toFixed(2)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
