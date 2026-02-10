/**
 * One-off: print current signed spread % for BTC, ETH, SOL (Kalshi 15m market).
 * Uses public APIs only (no auth). Run: npx tsx src/scripts/current-kalshi-spreads.ts
 */
import { getCurrentKalshiTicker } from '../kalshi/market.js';
import { getKalshiMarket } from '../kalshi/market.js';
import { fetchBinancePrice } from '../kalshi/spread.js';
import { strikeSpreadPctSigned } from '../kalshi/spread.js';

const ASSETS = ['BTC', 'ETH', 'SOL'] as const;

async function main() {
  console.log('Asset | Strike    | Binance  | Signed spread %');
  console.log('------|-----------|----------|----------------');
  for (const asset of ASSETS) {
    const ticker = await getCurrentKalshiTicker(asset);
    if (!ticker) {
      console.log(`${asset}   | (no market)`);
      continue;
    }
    const market = await getKalshiMarket(ticker);
    const strike = market.floor_strike;
    const price = await fetchBinancePrice(asset);
    if (strike == null) {
      console.log(`${asset}   | (no strike) | ${price.toFixed(2)} | -`);
      continue;
    }
    const signedSpread = strikeSpreadPctSigned(price, strike);
    console.log(`${asset}   | ${strike.toFixed(2).padStart(9)} | ${price.toFixed(2).padStart(8)} | ${signedSpread >= 0 ? '+' : ''}${signedSpread.toFixed(3)}%`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
