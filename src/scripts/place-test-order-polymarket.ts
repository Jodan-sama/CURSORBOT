/**
 * One-off: place a small test order on Polymarket (current BTC 15m, winning side).
 * Uses HTTP_PROXY/HTTPS_PROXY from .env if set. Run from repo root after build:
 *   node dist/scripts/place-test-order-polymarket.js
 * Or: npx tsx src/scripts/place-test-order-polymarket.ts
 */
import 'dotenv/config';

import { getCurrentPolySlug } from '../clock.js';
import { getPolyMarketBySlug } from '../polymarket/gamma.js';
import { createPolyClobClient, getPolyClobConfigFromEnv, getOrCreateDerivedPolyClient, createAndPostPolyOrder, orderParamsFromParsedMarket } from '../polymarket/clob.js';
import { getCurrentKalshiTicker } from '../kalshi/market.js';
import { getKalshiMarket } from '../kalshi/market.js';
import { parseKalshiTicker, isReasonableStrike } from '../kalshi/ticker.js';
import { fetchBinancePrice } from '../kalshi/spread.js';
import { strikeSpreadPctSigned } from '../kalshi/spread.js';

const ASSET = 'BTC';
const TEST_SIZE = 1; // 1 contract (~$1); use 5 if API returns min size error
const PRICE = 0.99;

async function main() {
  const now = new Date();
  const slug = getCurrentPolySlug(ASSET, now);
  console.log('Current BTC 15m Poly slug:', slug);

  const ticker = await getCurrentKalshiTicker(ASSET, undefined, now);
  if (!ticker) {
    console.error('No Kalshi ticker for strike; cannot determine winning side.');
    process.exit(1);
  }
  const km = await getKalshiMarket(ticker);
  const parsedK = parseKalshiTicker(ticker);
  const tickerStrike = parsedK?.strikeFromTicker;
  const floorStrike = km.floor_strike ?? null;
  const useTickerStrike =
    tickerStrike != null && isReasonableStrike(ASSET, tickerStrike);
  const validFloor =
    floorStrike != null &&
    floorStrike !== 0 &&
    isReasonableStrike(ASSET, floorStrike);
  const strike = (useTickerStrike ? tickerStrike : null) ?? (validFloor ? floorStrike : null);
  if (strike == null) {
    console.error('No strike; cannot determine winning side.');
    process.exit(1);
  }
  const price = await fetchBinancePrice(ASSET);
  const signedSpread = strikeSpreadPctSigned(price, strike);
  const side = signedSpread >= 0 ? 'yes' : 'no';
  console.log('Strike:', strike, '| Price:', price, '| Signed spread:', signedSpread.toFixed(3), '% | Winning side:', side);

  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '';
  console.log('Placing', side, 'order: size=', TEST_SIZE, 'price=', PRICE, proxy ? ' (Gamma + CLOB via proxy)' : ' (no proxy)...');

  const runPolyGammaAndOrder = async (): Promise<{ orderID?: string; status?: string }> => {
    const parsed = await getPolyMarketBySlug(slug);
    console.log('Market:', parsed.conditionId, '| outcomePrices:', parsed.outcomePrices);
    const config = getPolyClobConfigFromEnv();
    const client = config ? createPolyClobClient(config) : await getOrCreateDerivedPolyClient();
    const params = orderParamsFromParsedMarket(parsed, PRICE, TEST_SIZE, side);
    return await createAndPostPolyOrder(client, params);
  };

  const result = proxy
    ? await (async () => {
        const axios = (await import('axios')).default;
        const { HttpsProxyAgent } = await import('https-proxy-agent');
        const undici = await import('undici');
        const prevUndici = undici.getGlobalDispatcher();
        const prevAxiosAgent = axios.defaults.httpsAgent;
        const prevAxiosProxy = axios.defaults.proxy;
        const interceptor = axios.interceptors.response.use(
          (r) => r,
          (err) => {
            if (err.response) {
              console.error('[test] CLOB response error:', err.response.status, err.response.statusText, JSON.stringify(err.response.data));
            }
            return Promise.reject(err);
          }
        );
        try {
          undici.setGlobalDispatcher(new undici.ProxyAgent(proxy));
          axios.defaults.httpsAgent = new HttpsProxyAgent(proxy);
          axios.defaults.proxy = false;
          return await runPolyGammaAndOrder();
        } finally {
          axios.interceptors.response.eject(interceptor);
          undici.setGlobalDispatcher(prevUndici);
          axios.defaults.httpsAgent = prevAxiosAgent;
          axios.defaults.proxy = prevAxiosProxy;
        }
      })()
    : await runPolyGammaAndOrder();
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
