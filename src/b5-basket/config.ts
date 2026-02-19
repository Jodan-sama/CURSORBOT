/**
 * B5 basket bot config from env (no Supabase).
 */

export const B5_CONFIG = {
  positionSizeCap: Number(process.env.B5_POSITION_SIZE_USD) || 5,
  maxBasketCostCap: Number(process.env.B5_MAX_BASKET_COST) || 10,
  riskPerLeg: Number(process.env.B5_RISK_PER_LEG) || 0.015,
  maxPerBasket: Number(process.env.B5_MAX_PER_BASKET) || 0.06,
  /** Normal multi-leg: need edge >= this (and ≥2 candidates). */
  minEdge: Number(process.env.B5_MIN_EDGE) || 0.15,
  /** Solo 5-min: fire single leg if edge >= this. */
  strong5minEdge: Number(process.env.B5_STRONG_5MIN_EDGE) || 0.19,
  /** Solo 15-min: fire single leg if edge >= this. */
  strong15minEdge: Number(process.env.B5_STRONG_15MIN_EDGE) || 0.17,
  cheapThreshold: Number(process.env.B5_CHEAP_THRESHOLD) || 0.09,
  /** Scan every 5s. Override with B5_SCAN_INTERVAL_SECONDS if rate-limited. */
  scanIntervalSeconds: Number(process.env.B5_SCAN_INTERVAL_SECONDS) || 5,
  dailyLossLimit: Number(process.env.B5_DAILY_LOSS_LIMIT) ?? -0.05,
  minPositionUsd: 5,
  /** Skip 5-min outcomes when already this many seconds into window (early edges only). */
  max5minSecondsIntoWindow: Number(process.env.B5_MAX_5MIN_SECONDS_INTO_WINDOW) || 150,
};

export type B5Config = typeof B5_CONFIG;
