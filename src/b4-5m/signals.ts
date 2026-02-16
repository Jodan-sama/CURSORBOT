/**
 * Signal engine for B4 5-minute BTC strategy.
 * All signals produce a value in [-1, +1]. Positive = bullish (Up), negative = bearish (Down).
 *
 * v2: Added intra-window price action signal (uses first 2 minutes of current window).
 * This is the strongest signal — if BTC is already up after 2 min, it usually stays up.
 */

import type { Candle1m } from './download-candles.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ema(values: number[], period: number): number[] {
  const result: number[] = [];
  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      result.push(prev);
    } else {
      prev = values[i] * k + prev * (1 - k);
      result.push(prev);
    }
  }
  return result;
}

function rsi(closes: number[], period: number): number[] {
  const result: number[] = new Array(closes.length).fill(50);
  if (closes.length < period + 1) return result;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += -diff;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period; i < closes.length; i++) {
    if (i > period) {
      const diff = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result[i] = 100 - 100 / (1 + rs);
  }
  return result;
}

function atr(candles: Candle1m[], period: number): number[] {
  const result: number[] = new Array(candles.length).fill(0);
  if (candles.length < 2) return result;

  const trs: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      trs.push(candles[i].high - candles[i].low);
    } else {
      const prevClose = candles[i - 1].close;
      const tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - prevClose),
        Math.abs(candles[i].low - prevClose),
      );
      trs.push(tr);
    }
  }

  let atrVal = trs[0];
  for (let i = 0; i < trs.length; i++) {
    if (i < period) {
      atrVal = trs.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1);
    } else {
      atrVal = (atrVal * (period - 1) + trs[i]) / period;
    }
    result[i] = atrVal;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Individual Signals
// ---------------------------------------------------------------------------

export interface SignalInput {
  /** Last N 1-minute candles BEFORE the window opens (recommend 20+). */
  priorCandles: Candle1m[];
  /** First 2 candles of the CURRENT window (intra-window price action). */
  intraCandles: Candle1m[];
  /** Open price of the current window. */
  windowOpen: number;
  /** Outcomes of last 3 resolved 5-min windows: true = Up, false = Down. Most recent last. */
  lastWindowOutcomes: boolean[];
  /** Price change % of last 5-min window (signed: positive = up). */
  lastWindowChangePct: number;
}

export interface SignalOutput {
  intraWindow: number;  // [-1, 1] — strongest signal
  momentum: number;     // [-1, 1]
  volume: number;       // [-1, 1]
  rsiSignal: number;    // [-1, 1]
  trend: number;        // [-1, 1]
  volatility: number;   // 0 to 1 (multiplier)
  composite: number;    // weighted sum
  direction: 'up' | 'down' | 'skip';
}

const WEIGHTS = {
  intraWindow: 0.40,   // strongest: actual price action in first 2 min
  momentum: 0.20,
  volume: 0.15,
  rsi: 0.10,
  trend: 0.15,
};

const COMPOSITE_THRESHOLD = 0.25;
const HIGH_CONFIDENCE_THRESHOLD = 0.45;

/** Signal 0 (NEW, strongest): Intra-window price action — where is price after first 2 min? */
function computeIntraWindow(intraCandles: Candle1m[], windowOpen: number): number {
  if (intraCandles.length === 0 || windowOpen === 0) return 0;
  const lastClose = intraCandles[intraCandles.length - 1].close;
  const changePct = ((lastClose - windowOpen) / windowOpen) * 100;

  // Scale: 0.02% move → moderate signal, 0.05%+ → strong
  // BTC 5-min moves are small; 0.02% is ~$20 on $100k
  if (Math.abs(changePct) < 0.005) return 0; // too small, noise
  const signal = Math.max(-1, Math.min(1, changePct * 30)); // 0.033% → 1.0
  return signal;
}

/** Signal 1: Short-Term Momentum — EMA(5) vs EMA(15) on 1m closes. */
function computeMomentum(candles: Candle1m[]): number {
  if (candles.length < 15) return 0;
  const closes = candles.map((c) => c.close);
  const ema5 = ema(closes, 5);
  const ema15 = ema(closes, 15);
  const last5 = ema5[ema5.length - 1];
  const last15 = ema15[ema15.length - 1];
  const prev5 = ema5.length > 1 ? ema5[ema5.length - 2] : last5;

  const diff = (last5 - last15) / last15;
  const slope = (last5 - prev5) / prev5;

  if (diff > 0 && slope > 0) return Math.min(diff * 400, 1);
  if (diff < 0 && slope < 0) return Math.max(diff * 400, -1);
  if (diff > 0) return Math.min(diff * 200, 0.5);
  if (diff < 0) return Math.max(diff * 200, -0.5);
  return 0;
}

/** Signal 2: Volume Imbalance — taker buy vs total volume over last 5 candles. */
function computeVolume(candles: Candle1m[]): number {
  if (candles.length < 5) return 0;
  const recent = candles.slice(-5);
  const totalVol = recent.reduce((s, c) => s + c.volume, 0);
  const buyVol = recent.reduce((s, c) => s + c.takerBuyVolume, 0);
  if (totalVol === 0) return 0;

  const ratio = buyVol / totalVol;
  const signal = (ratio - 0.5) * 5;
  return Math.max(-1, Math.min(1, signal));
}

/** Signal 3: RSI Momentum — RSI(14) on 1m closes. */
function computeRsi(candles: Candle1m[]): number {
  if (candles.length < 15) return 0;
  const closes = candles.map((c) => c.close);
  const rsiValues = rsi(closes, 14);
  const lastRsi = rsiValues[rsiValues.length - 1];

  if (lastRsi > 60) return Math.min((lastRsi - 50) / 30, 1);
  if (lastRsi < 40) return Math.max((lastRsi - 50) / 30, -1);
  return (lastRsi - 50) / 50;
}

/** Signal 4: Multi-Window Trend — last 3 window outcomes. */
function computeTrend(lastWindowOutcomes: boolean[], lastChangePct: number): number {
  if (lastWindowOutcomes.length < 2) return 0;
  const last3 = lastWindowOutcomes.slice(-3);
  const allUp = last3.length >= 3 && last3.every((o) => o);
  const allDown = last3.length >= 3 && last3.every((o) => !o);

  let signal = 0;
  if (allUp) signal = 0.7;
  else if (allDown) signal = -0.7;
  else {
    const ups = last3.filter((o) => o).length;
    signal = (ups - last3.length / 2) / (last3.length / 2) * 0.4;
  }

  // Mean reversion after extreme moves
  if (Math.abs(lastChangePct) > 0.25) {
    const reversal = lastChangePct > 0 ? -0.3 : 0.3;
    signal = signal * 0.5 + reversal * 0.5;
  }

  return Math.max(-1, Math.min(1, signal));
}

/** Volatility filter — ATR(14) percentile. Returns multiplier 0.3-1.0 (low vol = dampened). */
function computeVolatility(candles: Candle1m[]): number {
  if (candles.length < 20) return 0.5;
  const atrValues = atr(candles, 14);
  const lastAtr = atrValues[atrValues.length - 1];

  const recentAtrs = atrValues.slice(-60);
  const sorted = [...recentAtrs].sort((a, b) => a - b);
  const idx = sorted.findIndex((v) => v >= lastAtr);
  const percentile = idx / sorted.length;

  if (percentile < 0.15) return 0.3;
  return 0.3 + percentile * 0.7;
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

export function computeSignals(input: SignalInput): SignalOutput {
  const intraWindow = computeIntraWindow(input.intraCandles, input.windowOpen);
  const momentum = computeMomentum(input.priorCandles);
  const volume = computeVolume(input.priorCandles);
  const rsiSignal = computeRsi(input.priorCandles);
  const trend = computeTrend(input.lastWindowOutcomes, input.lastWindowChangePct);
  const volatility = computeVolatility(input.priorCandles);

  const rawComposite =
    WEIGHTS.intraWindow * intraWindow +
    WEIGHTS.momentum * momentum +
    WEIGHTS.volume * volume +
    WEIGHTS.rsi * rsiSignal +
    WEIGHTS.trend * trend;

  const composite = rawComposite * volatility;

  let direction: 'up' | 'down' | 'skip' = 'skip';
  if (composite > COMPOSITE_THRESHOLD) direction = 'up';
  else if (composite < -COMPOSITE_THRESHOLD) direction = 'down';

  return { intraWindow, momentum, volume, rsiSignal, trend, volatility, composite, direction };
}

export { COMPOSITE_THRESHOLD, HIGH_CONFIDENCE_THRESHOLD, WEIGHTS };
