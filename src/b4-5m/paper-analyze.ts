/**
 * Paper Trade Analyzer
 *
 * Queries Supabase for paper trades (B4-paper / B5-paper) and produces
 * comprehensive statistics to determine which strategy is most profitable.
 *
 * Usage: npx ts-node src/b4-5m/paper-analyze.ts
 *        or: node dist/b4-5m/paper-analyze.js
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_KEY!;
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

interface PaperTradeRow {
  id: string;
  entered_at: string;
  bot: string;
  raw: {
    paper: boolean;
    strategy: 'momentum' | 'momentum-reverse' | 'spread';
    tier?: string;
    direction: 'up' | 'down';
    exitReason: string;
    entryMid: number;
    entryAsk: number;
    entryBid: number;
    exitMid: number;
    exitBid: number;
    exitAsk: number;
    midPnl: number;
    realPnl: number;
    won: boolean;
    entryBtcPrice: number;
    exitBtcPrice: number;
    momentumAtEntry?: number;
    spreadAtEntry?: number;
    cumPnl: number;
    cumWins: number;
    cumTrades: number;
  };
}

interface StrategyStats {
  name: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalRealPnl: number;
  totalMidPnl: number;
  avgRealPnl: number;
  avgWinPnl: number;
  avgLossPnl: number;
  maxWin: number;
  maxLoss: number;
  profitFactor: number;
  expectancy: number;
  exitReasons: Record<string, number>;
}

function computeStats(name: string, trades: PaperTradeRow[]): StrategyStats {
  const wins = trades.filter(t => t.raw.won);
  const losses = trades.filter(t => !t.raw.won);

  const totalRealPnl = trades.reduce((s, t) => s + t.raw.realPnl, 0);
  const totalMidPnl = trades.reduce((s, t) => s + t.raw.midPnl, 0);

  const winPnls = wins.map(t => t.raw.realPnl);
  const lossPnls = losses.map(t => t.raw.realPnl);

  const totalWinPnl = winPnls.reduce((s, p) => s + p, 0);
  const totalLossPnl = Math.abs(lossPnls.reduce((s, p) => s + p, 0));

  const exitReasons: Record<string, number> = {};
  for (const t of trades) {
    exitReasons[t.raw.exitReason] = (exitReasons[t.raw.exitReason] ?? 0) + 1;
  }

  return {
    name,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    totalRealPnl,
    totalMidPnl,
    avgRealPnl: trades.length > 0 ? totalRealPnl / trades.length : 0,
    avgWinPnl: wins.length > 0 ? totalWinPnl / wins.length : 0,
    avgLossPnl: losses.length > 0 ? -totalLossPnl / losses.length : 0,
    maxWin: winPnls.length > 0 ? Math.max(...winPnls) : 0,
    maxLoss: lossPnls.length > 0 ? Math.min(...lossPnls) : 0,
    profitFactor: totalLossPnl > 0 ? totalWinPnl / totalLossPnl : totalWinPnl > 0 ? Infinity : 0,
    expectancy: trades.length > 0 ? totalRealPnl / trades.length : 0,
    exitReasons,
  };
}

function printStats(s: StrategyStats): void {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${s.name}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Trades:        ${s.trades}`);
  console.log(`  Wins:          ${s.wins} (${(s.winRate * 100).toFixed(1)}%)`);
  console.log(`  Losses:        ${s.losses}`);
  console.log(`  Total PnL:     $${s.totalRealPnl.toFixed(3)} (mid: $${s.totalMidPnl.toFixed(3)})`);
  console.log(`  Avg PnL/trade: $${s.avgRealPnl.toFixed(3)}`);
  console.log(`  Avg Win:       $${s.avgWinPnl.toFixed(3)}`);
  console.log(`  Avg Loss:      $${s.avgLossPnl.toFixed(3)}`);
  console.log(`  Max Win:       $${s.maxWin.toFixed(3)}`);
  console.log(`  Max Loss:      $${s.maxLoss.toFixed(3)}`);
  console.log(`  Profit Factor: ${s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)}`);
  console.log(`  Expectancy:    $${s.expectancy.toFixed(3)}/trade`);
  console.log(`  Exit Reasons:`);
  for (const [reason, count] of Object.entries(s.exitReasons).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${reason}: ${count} (${(count / s.trades * 100).toFixed(0)}%)`);
  }
}

async function main(): Promise<void> {
  console.log('Fetching paper trades from Supabase...\n');

  const { data, error } = await db
    .from('positions')
    .select('*')
    .in('bot', ['B4-paper', 'B5-paper'])
    .order('entered_at', { ascending: true });

  if (error) {
    console.error('Supabase error:', error);
    process.exit(1);
  }

  const trades = (data ?? []) as PaperTradeRow[];
  console.log(`Total paper trades: ${trades.length}`);

  if (trades.length === 0) {
    console.log('No paper trades found. Let the paper trader run for a few hours first.');
    process.exit(0);
  }

  // Time range
  const first = new Date(trades[0].entered_at);
  const last = new Date(trades[trades.length - 1].entered_at);
  const hoursRunning = (last.getTime() - first.getTime()) / (1000 * 60 * 60);
  console.log(`Time range: ${first.toISOString()} → ${last.toISOString()} (${hoursRunning.toFixed(1)} hours)`);
  console.log(`Windows covered: ~${Math.round(hoursRunning * 12)} (5-min each)`);

  // Filter out trades at extreme prices (entry ask >= 0.95 or <= 0.05)
  const validTrades = trades.filter(t => {
    if (!t.raw) return false;
    const ask = t.raw.entryAsk;
    return ask > 0.05 && ask < 0.95;
  });
  const skipped = trades.length - validTrades.length;
  if (skipped > 0) {
    console.log(`Filtered out ${skipped} trades at extreme entry prices (ask >= 0.95 or <= 0.05)`);
  }

  // Group by strategy
  const momentumNormal = validTrades.filter(t => t.raw?.strategy === 'momentum');
  const momentumReverse = validTrades.filter(t => t.raw?.strategy === 'momentum-reverse');
  const spreadAll = validTrades.filter(t => t.raw?.strategy === 'spread');
  const spreadT1 = spreadAll.filter(t => t.raw?.tier === 'B5-T1');
  const spreadT2 = spreadAll.filter(t => t.raw?.tier === 'B5-T2');
  const spreadT3 = spreadAll.filter(t => t.raw?.tier === 'B5-T3');

  // Compute and print stats
  const allStats: StrategyStats[] = [];

  if (momentumNormal.length > 0) {
    const s = computeStats('B4 Momentum (Normal)', momentumNormal);
    allStats.push(s);
    printStats(s);
  }

  if (momentumReverse.length > 0) {
    const s = computeStats('B4 Momentum (Reverse)', momentumReverse);
    allStats.push(s);
    printStats(s);
  }

  if (spreadAll.length > 0) {
    const s = computeStats('B5 Spread (All Tiers)', spreadAll);
    allStats.push(s);
    printStats(s);
  }

  if (spreadT1.length > 0) {
    const s = computeStats('B5 Spread T1 (>0.12%, last 50s)', spreadT1);
    allStats.push(s);
    printStats(s);
  }

  if (spreadT2.length > 0) {
    const s = computeStats('B5 Spread T2 (>0.33%, last 100s)', spreadT2);
    allStats.push(s);
    printStats(s);
  }

  if (spreadT3.length > 0) {
    const s = computeStats('B5 Spread T3 (>0.58%, last 160s)', spreadT3);
    allStats.push(s);
    printStats(s);
  }

  // Recommendation
  console.log('\n' + '═'.repeat(60));
  console.log('  RECOMMENDATION');
  console.log('═'.repeat(60));

  if (allStats.length === 0) {
    console.log('  No valid trades to analyze.');
  } else {
    // Rank by expectancy (average PnL per trade)
    const ranked = [...allStats]
      .filter(s => s.trades >= 5)
      .sort((a, b) => b.expectancy - a.expectancy);

    if (ranked.length === 0) {
      console.log('  Not enough trades (need ≥5 per strategy). Keep running the paper trader.');
    } else {
      console.log('  Ranking by expectancy (avg PnL/trade):');
      for (let i = 0; i < ranked.length; i++) {
        const s = ranked[i];
        const emoji = i === 0 ? '>>>' : '   ';
        console.log(
          `  ${emoji} #${i + 1}: ${s.name} — $${s.expectancy.toFixed(3)}/trade, ` +
          `WR=${(s.winRate * 100).toFixed(1)}%, PF=${s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)}, ` +
          `${s.trades} trades, total PnL=$${s.totalRealPnl.toFixed(2)}`
        );
      }

      const best = ranked[0];
      const minTrades = 30;
      if (best.trades < minTrades) {
        console.log(`\n  NOTE: Top strategy only has ${best.trades} trades. Recommend waiting for ${minTrades}+ for statistical significance.`);
      }

      if (best.expectancy > 0 && best.trades >= minTrades) {
        console.log(`\n  DEPLOY: ${best.name} looks profitable. Ready for live deployment with $5 sizing.`);
        const dailyTrades = best.trades / Math.max(hoursRunning, 1) * 24;
        console.log(`  Projected daily PnL: $${(dailyTrades * best.expectancy).toFixed(2)} (${dailyTrades.toFixed(0)} trades/day)`);
      } else if (best.expectancy <= 0) {
        console.log('\n  NO PROFITABLE STRATEGY FOUND. All strategies are net negative.');
        console.log('  Consider adjusting parameters or waiting for more data.');
      }
    }
  }

  console.log('');
}

main().catch(e => {
  console.error('Analysis failed:', e);
  process.exit(1);
});
