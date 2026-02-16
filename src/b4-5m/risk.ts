/**
 * Risk manager for B4 5-minute bot.
 *
 * 5-phase Kelly sizing, drawdown limits, daily loss cap, cooldown escalation,
 * win-rate circuit breaker, bankroll persistence via Supabase.
 *
 * Phase 1  ($30 – $200):       $5 flat, 0.45 confidence threshold
 * Phase 2  ($200 – $5,000):    Kelly ≤15%, 0.25 threshold
 * Phase 3  ($5,000 – $30,000): Kelly ≤10%, 0.25 threshold
 * Phase 4a ($30k – $200k):     Kelly ≤5%, max $2,500/trade, 0.30 threshold
 * Phase 4b ($200k – $1M):      Kelly ≤3%, max $5,000/trade, 0.35 threshold
 */

const MIN_BET = 5;
const TARGET_BANKROLL = 1_000_000;

// Phase boundaries
export type Phase = 1 | 2 | 3 | '4a' | '4b';

export function getPhase(bankroll: number): Phase {
  if (bankroll < 200) return 1;
  if (bankroll < 5_000) return 2;
  if (bankroll < 30_000) return 3;
  if (bankroll < 200_000) return '4a';
  return '4b';
}

export function getPhaseLabel(phase: Phase): string {
  if (phase === '4a') return 'Phase 4a ($30k–$200k)';
  if (phase === '4b') return 'Phase 4b ($200k–$1M)';
  return `Phase ${phase}`;
}

// ---------------------------------------------------------------------------
// Risk State
// ---------------------------------------------------------------------------

export interface RiskState {
  bankroll: number;
  maxBankroll: number;
  consecutiveLosses: number;
  cooldownUntilMs: number;
  results: boolean[];

  /** Daily loss tracking (UTC day) */
  dailyStartBankroll: number;
  dailyStartDate: string;

  /** After 25% drawdown recovery, trade at half-Kelly for N trades */
  halfKellyTradesLeft: number;
}

export function createRiskState(initialBankroll: number): RiskState {
  return {
    bankroll: initialBankroll,
    maxBankroll: initialBankroll,
    consecutiveLosses: 0,
    cooldownUntilMs: 0,
    results: [],
    dailyStartBankroll: initialBankroll,
    dailyStartDate: new Date().toISOString().slice(0, 10),
    halfKellyTradesLeft: 0,
  };
}

/** Restore state from persisted Supabase row. */
export function restoreRiskState(row: {
  bankroll: number;
  max_bankroll: number;
  consecutive_losses: number;
  cooldown_until_ms: number;
  results_json: boolean[];
  daily_start_bankroll: number;
  daily_start_date: string;
  half_kelly_trades_left: number;
}): RiskState {
  return {
    bankroll: row.bankroll,
    maxBankroll: row.max_bankroll,
    consecutiveLosses: row.consecutive_losses,
    cooldownUntilMs: row.cooldown_until_ms,
    results: row.results_json ?? [],
    dailyStartBankroll: row.daily_start_bankroll,
    dailyStartDate: row.daily_start_date,
    halfKellyTradesLeft: row.half_kelly_trades_left,
  };
}

/** Serialize state for Supabase persistence. */
export function serializeRiskState(state: RiskState) {
  return {
    bankroll: state.bankroll,
    max_bankroll: state.maxBankroll,
    consecutive_losses: state.consecutiveLosses,
    cooldown_until_ms: state.cooldownUntilMs,
    results_json: state.results,
    daily_start_bankroll: state.dailyStartBankroll,
    daily_start_date: state.dailyStartDate,
    half_kelly_trades_left: state.halfKellyTradesLeft,
  };
}

// ---------------------------------------------------------------------------
// Win rate
// ---------------------------------------------------------------------------

function rollingWinRate(results: boolean[], window = 50): number {
  if (results.length < 10) return 0.52;
  const recent = results.slice(-window);
  return recent.filter((w) => w).length / recent.length;
}

/** Longer-window win rate for circuit breaker (last 100 trades). */
function longWinRate(results: boolean[]): number {
  if (results.length < 30) return 0.52;
  const recent = results.slice(-100);
  return recent.filter((w) => w).length / recent.length;
}

export function getWinRate(state: RiskState): number {
  return rollingWinRate(state.results);
}

// ---------------------------------------------------------------------------
// Daily P&L tracking
// ---------------------------------------------------------------------------

function ensureDailyReset(state: RiskState, now: Date): void {
  const today = now.toISOString().slice(0, 10);
  if (state.dailyStartDate !== today) {
    state.dailyStartDate = today;
    state.dailyStartBankroll = state.bankroll;
  }
}

export function getDailyPnl(state: RiskState): number {
  return state.bankroll - state.dailyStartBankroll;
}

export function getDailyPnlPct(state: RiskState): number {
  if (state.dailyStartBankroll <= 0) return 0;
  return ((state.bankroll - state.dailyStartBankroll) / state.dailyStartBankroll) * 100;
}

// ---------------------------------------------------------------------------
// Should-trade checks (all risk controls)
// ---------------------------------------------------------------------------

export interface TradeDecision {
  ok: boolean;
  reason?: string;
}

export function shouldTrade(state: RiskState, now: Date): TradeDecision {
  // Bust
  if (state.bankroll < MIN_BET) return { ok: false, reason: 'bust' };

  // Target reached
  if (state.bankroll >= TARGET_BANKROLL) return { ok: false, reason: 'target reached ($1M)' };

  // Cooldown active
  if (now.getTime() < state.cooldownUntilMs) {
    const minLeft = Math.ceil((state.cooldownUntilMs - now.getTime()) / 60_000);
    return { ok: false, reason: `cooldown (${minLeft} min left)` };
  }

  const phase = getPhase(state.bankroll);

  // Phase 1 drawdown pause (original logic)
  if (phase === 1 && state.bankroll < state.maxBankroll * 0.5) {
    return { ok: false, reason: 'drawdown pause (Phase 1)' };
  }

  // Phase 4a/4b: 25% drawdown halt — pause 1 hour, then resume at half-Kelly
  if ((phase === '4a' || phase === '4b') && state.bankroll < state.maxBankroll * 0.75) {
    state.cooldownUntilMs = now.getTime() + 60 * 60 * 1000;
    state.halfKellyTradesLeft = 50;
    return { ok: false, reason: `25% drawdown halt (${getPhaseLabel(phase)}) — pausing 1h, then half-Kelly` };
  }

  // Daily loss limit: 10% of daily start bankroll
  ensureDailyReset(state, now);
  const dailyLoss = state.dailyStartBankroll - state.bankroll;
  if (dailyLoss > state.dailyStartBankroll * 0.10 && (phase === '4a' || phase === '4b')) {
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    state.cooldownUntilMs = midnight.getTime();
    return { ok: false, reason: `daily loss limit (-$${dailyLoss.toFixed(0)}, >10%) — pausing until next UTC day` };
  }

  // Win-rate circuit breaker: rolling 100-trade WR < 48% → halt
  const lwr = longWinRate(state.results);
  if (state.results.length >= 30 && lwr < 0.48) {
    return { ok: false, reason: `circuit breaker: WR ${(lwr * 100).toFixed(1)}% < 48% over last ${Math.min(100, state.results.length)} trades` };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Confidence threshold
// ---------------------------------------------------------------------------

export function getConfidenceThreshold(state: RiskState): number {
  const phase = getPhase(state.bankroll);
  switch (phase) {
    case 1: return 0.45;
    case 2: return 0.25;
    case 3: return 0.25;
    case '4a': return 0.30;
    case '4b': return 0.35;
  }
}

// ---------------------------------------------------------------------------
// Position sizing
// ---------------------------------------------------------------------------

const PHASE_CONFIG: Record<string, { kellyCap: number; maxBet: number }> = {
  '1':  { kellyCap: 0, maxBet: MIN_BET },
  '2':  { kellyCap: 0.15, maxBet: Infinity },
  '3':  { kellyCap: 0.10, maxBet: Infinity },
  '4a': { kellyCap: 0.05, maxBet: 2_500 },
  '4b': { kellyCap: 0.03, maxBet: 5_000 },
};

export function getBetSize(state: RiskState): number {
  const phase = getPhase(state.bankroll);
  const wr = rollingWinRate(state.results);
  const config = PHASE_CONFIG[String(phase)];

  // Phase 1 or low WR: flat minimum
  if (phase === 1 || wr < 0.45) return MIN_BET;

  // Kelly fraction: f = 2*WR - 1, capped by phase
  let f = Math.max(0, 2 * wr - 1);
  f = Math.min(f, config.kellyCap);

  // Half-Kelly after drawdown recovery
  if (state.halfKellyTradesLeft > 0) f *= 0.5;

  // Below 50% WR in Phase 4: force half-Kelly
  if ((phase === '4a' || phase === '4b') && wr < 0.50) f *= 0.5;

  let bet = Math.max(MIN_BET, Math.floor(state.bankroll * f));

  // Absolute dollar cap
  bet = Math.min(bet, config.maxBet);

  // Never bet more than bankroll
  bet = Math.min(bet, state.bankroll);

  return bet;
}

// ---------------------------------------------------------------------------
// Record outcome
// ---------------------------------------------------------------------------

export function recordResult(state: RiskState, won: boolean, betSize: number): void {
  if (won) {
    state.bankroll += betSize;
    state.consecutiveLosses = 0;
  } else {
    state.bankroll -= betSize;
    state.consecutiveLosses++;

    const phase = getPhase(state.bankroll);

    // Escalating cooldown
    if (phase === '4a' || phase === '4b') {
      if (state.consecutiveLosses >= 5) {
        state.cooldownUntilMs = Date.now() + 2 * 60 * 60 * 1000; // 2 hours
        state.consecutiveLosses = 0;
      } else if (state.consecutiveLosses >= 3) {
        state.cooldownUntilMs = Date.now() + 30 * 60 * 1000; // 30 min
      }
    } else {
      if (state.consecutiveLosses >= 5) {
        state.cooldownUntilMs = Date.now() + 15 * 60 * 1000; // 15 min
        state.consecutiveLosses = 0;
      }
    }
  }

  // Track half-Kelly countdown
  if (state.halfKellyTradesLeft > 0) state.halfKellyTradesLeft--;

  state.results.push(won);
  if (state.results.length > 200) state.results.splice(0, state.results.length - 200);
  if (state.bankroll > state.maxBankroll) state.maxBankroll = state.bankroll;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export function getRiskSummary(state: RiskState): string {
  const wr = rollingWinRate(state.results);
  const phase = getPhase(state.bankroll);
  const dd = state.maxBankroll > 0 ? ((state.maxBankroll - state.bankroll) / state.maxBankroll * 100).toFixed(1) : '0';
  const dailyPnl = getDailyPnl(state);
  const dailyStr = dailyPnl >= 0 ? `+$${dailyPnl.toFixed(0)}` : `-$${Math.abs(dailyPnl).toFixed(0)}`;
  const halfK = state.halfKellyTradesLeft > 0 ? ` | half-Kelly: ${state.halfKellyTradesLeft} left` : '';
  return `Phase ${phase} | $${state.bankroll.toFixed(2)} | WR ${(wr * 100).toFixed(1)}% (${state.results.length} trades) | DD ${dd}% | day ${dailyStr} | consec losses ${state.consecutiveLosses}${halfK}`;
}

export function isTargetReached(state: RiskState): boolean {
  return state.bankroll >= TARGET_BANKROLL;
}

export { MIN_BET, TARGET_BANKROLL };
