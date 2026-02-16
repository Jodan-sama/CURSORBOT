/**
 * Risk manager for B4 5-minute bot.
 * Kelly sizing, drawdown limits, cooldown, win-rate tracking.
 */

const MIN_BET = 5;

export interface RiskState {
  bankroll: number;
  maxBankroll: number;
  consecutiveLosses: number;
  cooldownUntilMs: number;
  results: boolean[]; // rolling window of win/loss
}

export function createRiskState(initialBankroll: number): RiskState {
  return {
    bankroll: initialBankroll,
    maxBankroll: initialBankroll,
    consecutiveLosses: 0,
    cooldownUntilMs: 0,
    results: [],
  };
}

function getPhase(bankroll: number): 1 | 2 | 3 {
  if (bankroll < 200) return 1;
  if (bankroll < 5000) return 2;
  return 3;
}

function rollingWinRate(results: boolean[]): number {
  if (results.length < 10) return 0.52;
  const recent = results.slice(-50);
  return recent.filter((w) => w).length / recent.length;
}

export function shouldTrade(state: RiskState, now: Date): { ok: boolean; reason?: string } {
  if (state.bankroll < MIN_BET) return { ok: false, reason: 'bust' };
  if (now.getTime() < state.cooldownUntilMs) return { ok: false, reason: 'cooldown' };
  if (state.bankroll < state.maxBankroll * 0.5 && state.bankroll < 200) return { ok: false, reason: 'drawdown pause' };
  return { ok: true };
}

export function getConfidenceThreshold(state: RiskState): number {
  const phase = getPhase(state.bankroll);
  return phase === 1 ? 0.45 : 0.25;
}

export function getBetSize(state: RiskState): number {
  const phase = getPhase(state.bankroll);
  const wr = rollingWinRate(state.results);

  if (wr < 0.45) return MIN_BET;
  if (phase === 1) return MIN_BET;

  const cap = phase === 2 ? 0.15 : 0.10;
  const f = Math.max(0, 2 * wr - 1);
  const fraction = Math.min(f, cap);
  const bet = Math.max(MIN_BET, Math.floor(state.bankroll * fraction));
  return Math.min(bet, state.bankroll);
}

export function recordResult(state: RiskState, won: boolean, betSize: number): void {
  if (won) {
    state.bankroll += betSize;
    state.consecutiveLosses = 0;
  } else {
    state.bankroll -= betSize;
    state.consecutiveLosses++;
    if (state.consecutiveLosses >= 5) {
      state.cooldownUntilMs = Date.now() + 15 * 60 * 1000; // 15 min cooldown
      state.consecutiveLosses = 0;
    }
  }

  state.results.push(won);
  if (state.results.length > 200) state.results.splice(0, state.results.length - 200);
  if (state.bankroll > state.maxBankroll) state.maxBankroll = state.bankroll;
}

export function getRiskSummary(state: RiskState): string {
  const wr = rollingWinRate(state.results);
  const phase = getPhase(state.bankroll);
  const dd = state.maxBankroll > 0 ? ((state.maxBankroll - state.bankroll) / state.maxBankroll * 100).toFixed(1) : '0';
  return `Phase ${phase} | $${state.bankroll.toFixed(2)} | WR ${(wr * 100).toFixed(1)}% (${state.results.length} trades) | DD ${dd}% | consec losses ${state.consecutiveLosses}`;
}

export { MIN_BET };
