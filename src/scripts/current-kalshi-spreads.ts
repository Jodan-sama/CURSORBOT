/**
 * Live comparison: Binance vs CoinGecko prices and signed spread % for BTC, ETH, SOL.
 * Refreshes every 5 seconds. Run: npx tsx src/scripts/current-kalshi-spreads.ts
 */
import { getCurrentKalshiTicker } from '../kalshi/market.js';
import { getKalshiMarket } from '../kalshi/market.js';
import { fetchBinancePriceOnly, fetchCoinGeckoPrice } from '../kalshi/spread.js';
import { strikeSpreadPctSigned } from '../kalshi/spread.js';

const ASSETS = ['BTC', 'ETH', 'SOL'] as const;
const REFRESH_MS = 5_000;

function fmtPrice(n: number): string {
  return n.toFixed(2).padStart(10);
}

function fmtSpread(n: number): string {
  const s = `${n >= 0 ? '+' : ''}${n.toFixed(3)}%`;
  return s.padStart(9);
}

async function fetchPriceOrNull(
  asset: (typeof ASSETS)[number],
  fetch: (a: (typeof ASSETS)[number]) => Promise<number>
): Promise<number | null> {
  try {
    return await fetch(asset);
  } catch {
    return null;
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

  for (const asset of ASSETS) {
    const ticker = await getCurrentKalshiTicker(asset);
    if (!ticker) {
      console.log(`${asset}   | (no market)`);
      continue;
    }
    const market = await getKalshiMarket(ticker);
    const strike = market.floor_strike;
    if (strike == null) {
      console.log(`${asset}   | (no strike)`);
      continue;
    }

    const [binancePrice, coingeckoPrice] = await Promise.all([
      fetchPriceOrNull(asset, fetchBinancePriceOnly),
      fetchPriceOrNull(asset, fetchCoinGeckoPrice),
    ]);

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
  console.log('Kalshi 15m spread comparison — Binance vs CoinGecko (refresh every 5s). Ctrl+C to exit.');
  for (;;) {
    await runOne();
    await new Promise((r) => setTimeout(r, REFRESH_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
