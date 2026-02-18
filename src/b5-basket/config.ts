/**
 * B5 basket bot config from env (no Supabase).
 */

export const B5_CONFIG = {
  positionSizeCap: Number(process.env.B5_POSITION_SIZE_USD) || 5,
  maxBasketCostCap: Number(process.env.B5_MAX_BASKET_COST) || 10,
  riskPerLeg: Number(process.env.B5_RISK_PER_LEG) || 0.015,
  maxPerBasket: Number(process.env.B5_MAX_PER_BASKET) || 0.06,
  minEdge: Number(process.env.B5_MIN_EDGE) || 0.2,
  cheapThreshold: Number(process.env.B5_CHEAP_THRESHOLD) || 0.08,
  scanIntervalSeconds: Number(process.env.B5_SCAN_INTERVAL_SECONDS) || 300,
  dailyLossLimit: Number(process.env.B5_DAILY_LOSS_LIMIT) ?? -0.05,
  minPositionUsd: 5,
};

export type B5Config = typeof B5_CONFIG;
