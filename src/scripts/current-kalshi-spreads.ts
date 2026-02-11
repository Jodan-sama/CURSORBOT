/**
 * Live comparison: Binance vs CoinGecko prices and signed spread % for BTC, ETH, SOL, XRP.
 * Refreshes every 5 seconds. Run: npm run spreads  or  npx tsx src/scripts/current-kalshi-spreads.ts
 */
import { getCurrentKalshiTicker, getKalshiMarket } from '../kalshi/market.js';
import { parseKalshiTicker, isReasonableStrike, strikeMatchesPrice } from '../kalshi/ticker.js';
import { fetchBinancePriceOnly, fetchCoinGeckoPricesAll } from '../kalshi/spread.js';
import { strikeSpreadPctSigned } from '../kalshi/spread.js';

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'] as const;
const REFRESH_MS = 5_000;
/** Cache CoinGecko for 60s so we don't get rate limited (free tier ~1 req/min). */
const COINGECKO_CACHE_MS = 60_000;

let coingeckoCache: { prices: Record<(typeof ASSETS)[number], number>; at: number } | null = null;

function fmtPrice(n: number): string {
  return n.toFixed(2).padStart(10);
}

function fmtSpread(n: number): string {
  const s = `${n >= 0 ? '+' : ''}${n.toFixed(3)}%`;
  return s.padStart(9);
}

async function fetchBinanceOrNull(asset: (typeof ASSETS)[number]): Promise<number | null> {
  try {
    return await fetchBinancePriceOnly(asset);
  } catch {
    return null;
  }
}

async function getCoinGeckoPrices(): Promise<Record<(typeof ASSETS)[number], number> | null> {
  const now = Date.now();
  if (coingeckoCache && now - coingeckoCache.at < COINGECKO_CACHE_MS) {
    return coingeckoCache.prices;
  }
  try {
    const prices = await fetchCoinGeckoPricesAll();
    coingeckoCache = { prices, at: now };
    return prices;
  } catch {
    return coingeckoCache?.prices ?? null;
  }
}

async function runOne(): Promise<void> {
  console.log('\n' + new Date().toISOString() + ' (UTC)');
  console.log(
    'Asset | Strike      | Binance    | Binance %  | CoinGecko  | CoinGecko %'
  );
  console.log(
    '------|-------------|------------|------------|------------|------------'
  );

  const coingeckoPrices = await getCoinGeckoPrices();

  for (const asset of ASSETS) {
    const ticker = await getCurrentKalshiTicker(asset);
    if (!ticker) {
      console.log(`${asset}   | (no market)`);
      continue;
    }
    const market = await getKalshiMarket(ticker);
    const parsed = parseKalshiTicker(ticker);
    const tickerStrike = parsed?.strikeFromTicker;
    const floorStrike = market.floor_strike ?? null;

    const binancePrice = await fetchBinanceOrNull(asset);
    const rawCg = coingeckoPrices?.[asset];
    const coingeckoPrice =
      rawCg != null && !Number.isNaN(rawCg) ? rawCg : null;
    const spotPrice = binancePrice ?? coingeckoPrice ?? 0;

    const useTickerStrike =
      tickerStrike != null &&
      isReasonableStrike(asset, tickerStrike) &&
      (spotPrice > 0 ? strikeMatchesPrice(tickerStrike, spotPrice) : true);
    const validFloor =
      floorStrike != null &&
      floorStrike !== 0 &&
      isReasonableStrike(asset, floorStrike) &&
      (spotPrice > 0 ? strikeMatchesPrice(floorStrike, spotPrice) : true);
    const strike = (useTickerStrike ? tickerStrike : null) ?? (validFloor ? floorStrike : null);
    if (strike == null) {
      const bogus = tickerStrike ?? floorStrike;
      const note = bogus != null && spotPrice > 0 ? ` (Kalshi strike ${bogus} rejected vs spot ${spotPrice.toFixed(2)})` : '';
      console.log(`${asset}   | (no valid strike)${note}`);
      continue;
    }

    const binanceStr =
      binancePrice != null ? fmtPrice(binancePrice) : '        N/A';
    const coingeckoStr =
      coingeckoPrice != null ? fmtPrice(coingeckoPrice) : '        N/A';

    const binanceSpread =
      binancePrice != null
        ? strikeSpreadPctSigned(binancePrice, strike)
        : null;
    const coingeckoSpread =
      coingeckoPrice != null
        ? strikeSpreadPctSigned(coingeckoPrice, strike)
        : null;

    const binancePctStr =
      binanceSpread != null ? fmtSpread(binanceSpread) : '       N/A';
    const coingeckoPctStr =
      coingeckoSpread != null ? fmtSpread(coingeckoSpread) : '       N/A';

    const strikeStr = strike.toFixed(2).padStart(11);
    console.log(
      `${asset}   | ${strikeStr} | ${binanceStr} | ${binancePctStr} | ${coingeckoStr} | ${coingeckoPctStr}`
    );
  }
}

async function main(): Promise<void> {
  console.log('Kalshi 15m spreads — BTC, ETH, SOL, XRP (refresh every 5s). Ctrl+C to exit.');
  for (;;) {
    await runOne();
    await new Promise((r) => setTimeout(r, REFRESH_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
