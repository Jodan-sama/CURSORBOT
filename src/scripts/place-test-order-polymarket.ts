/**
 * One-off: place a small test order on Polymarket (current BTC 15m, winning side).
 * Uses HTTP_PROXY/HTTPS_PROXY from .env if set. Run from repo root after build:
 *   node dist/scripts/place-test-order-polymarket.js
 * Or: npx tsx src/scripts/place-test-order-polymarket.ts
 */
import 'dotenv/config';

if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
  process.env.GLOBAL_AGENT_HTTP_PROXY = process.env.HTTP_PROXY ?? process.env.HTTPS_PROXY ?? '';
  process.env.GLOBAL_AGENT_HTTPS_PROXY = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '';
  const { bootstrap } = await import('global-agent');
  bootstrap();
}

import { getCurrentPolySlug } from '../clock.js';
import { getPolyMarketBySlug } from '../polymarket/gamma.js';
import { createPolyClobClient, getPolyClobConfigFromEnv, createAndPostPolyOrder, orderParamsFromParsedMarket } from '../polymarket/clob.js';
import { getCurrentKalshiTicker } from '../kalshi/market.js';
import { getKalshiMarket } from '../kalshi/market.js';
import { parseKalshiTicker } from '../kalshi/ticker.js';
import { fetchBinancePrice } from '../kalshi/spread.js';
import { strikeSpreadPctSigned } from '../kalshi/spread.js';

const ASSET = 'BTC';
const TEST_SIZE = 1; // 1 contract (~$1); use 5 if API returns min size error
const PRICE = 0.99;

async function main() {
  const now = new Date();
  const slug = getCurrentPolySlug(ASSET, now);
  console.log('Current BTC 15m Poly slug:', slug);

  const parsed = await getPolyMarketBySlug(slug);
  console.log('Market:', parsed.conditionId, '| outcomePrices:', parsed.outcomePrices);

  const ticker = await getCurrentKalshiTicker(ASSET, undefined, now);
  if (!ticker) {
    console.error('No Kalshi ticker for strike; cannot determine winning side.');
    process.exit(1);
  }
  const km = await getKalshiMarket(ticker);
  const parsedK = parseKalshiTicker(ticker);
  const strike = (parsedK?.strikeFromTicker != null ? parsedK.strikeFromTicker : null) ?? km.floor_strike ?? null;
  if (strike == null) {
    console.error('No strike; cannot determine winning side.');
    process.exit(1);
  }
  const price = await fetchBinancePrice(ASSET);
  const signedSpread = strikeSpreadPctSigned(price, strike);
  const side = signedSpread >= 0 ? 'yes' : 'no';
  console.log('Strike:', strike, '| Price:', price, '| Signed spread:', signedSpread.toFixed(3), '% | Winning side:', side);

  const config = getPolyClobConfigFromEnv();
  const client = createPolyClobClient(config);
  const params = orderParamsFromParsedMarket(parsed, PRICE, TEST_SIZE, side);
  console.log('Placing', side, 'order: size=', TEST_SIZE, 'price=', PRICE, '...');

  const result = await createAndPostPolyOrder(client, params);
  console.log('Result:', result);
  if (result.orderID) {
    console.log('Test order placed: orderID=', result.orderID, '| status=', result.status);
  } else {
    console.error('No orderID in response.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
