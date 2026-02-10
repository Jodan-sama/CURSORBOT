/**
 * Cursorbot – 15M prediction market trading (Kalshi + Polymarket).
 * Entry point for the long-running bot process.
 */

// Placeholder: bot loop will live here
console.log('Cursorbot starting (Kalshi + Polymarket 15M)');

export { parseKalshiTicker, getBinanceSymbol } from './kalshi/ticker.js';
export type { Asset, ParsedTicker } from './kalshi/ticker.js';
export {
  fetchBinancePrice,
  strikeSpreadPct,
  BOT_SPREAD_THRESHOLD_PCT,
  isOutsideSpreadThreshold,
} from './kalshi/spread.js';
export { getKalshiMarket, kalshiYesBidAsPercent } from './kalshi/market.js';
export type { KalshiMarket } from './kalshi/market.js';

export {
  fetchGammaEvent,
  getPolyMarketBySlug,
  parseGammaMarket,
  poly15mSlug,
  POLY_15M_SLUG_PREFIX,
} from './polymarket/gamma.js';
export type { ParsedPolyMarket } from './polymarket/types.js';
export type { GammaEvent, GammaMarket } from './polymarket/types.js';
export {
  createPolyClobClient,
  getPolyClobConfigFromEnv,
  createAndPostPolyOrder,
  orderParamsFromParsedMarket,
} from './polymarket/clob.js';
export type { PolyClobConfig, CreatePolyOrderParams } from './polymarket/clob.js';
