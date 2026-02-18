/**
 * One-off: place a $1 test order on the current 5-min BTC market (leading side).
 * Uses B5/D3 env (POLYMARKET_*, HTTPS_PROXY). Run on D3:
 *   cd /root/cursorbot && DOTENV_CONFIG_PATH=.env node dist/scripts/place-b5-test-order.js
 */
import 'dotenv/config';
import { getPolySlug5m } from '../b4-5m/clock.js';
import { getPolyMarketBySlug } from '../polymarket/gamma.js';
import {
  createPolyClobClient,
  getPolyClobConfigFromEnv,
  getOrCreateDerivedPolyClient,
} from '../polymarket/clob.js';
import { Side, OrderType } from '@polymarket/clob-client';

const TEST_AMOUNT_USD = 1;

async function withPolyProxy<T>(fn: () => Promise<T>): Promise<T> {
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '';
  if (!proxy) return fn();
  const axios = (await import('axios')).default;
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  const undici = await import('undici');
  const prev = undici.getGlobalDispatcher();
  const prevAxiosAgent = axios.defaults.httpsAgent;
  const prevAxiosProxy = axios.defaults.proxy;
  try {
    undici.setGlobalDispatcher(new undici.ProxyAgent(proxy));
    axios.defaults.httpsAgent = new HttpsProxyAgent(proxy);
    axios.defaults.proxy = false;
    return await fn();
  } finally {
    undici.setGlobalDispatcher(prev);
    axios.defaults.httpsAgent = prevAxiosAgent;
    axios.defaults.proxy = prevAxiosProxy;
  }
}

async function main() {
  const now = new Date();
  const slug = getPolySlug5m(now);
  console.log('[B5 test] 5m slug:', slug);

  await withPolyProxy(async () => {
    const market = await getPolyMarketBySlug(slug);
    const yesPrice = market.outcomePrices?.[0] ?? 0.5;
    const noPrice = market.outcomePrices?.[1] ?? 0.5;
    const side: 'yes' | 'no' = yesPrice >= noPrice ? 'yes' : 'no';
    const tokenId = side === 'yes' ? market.clobTokenIds[0] : market.clobTokenIds[1];
    if (!tokenId) {
      console.error('[B5 test] No token for', side);
      process.exit(1);
    }
    console.log('[B5 test] Leading side:', side, '| yes=', yesPrice.toFixed(3), 'no=', noPrice.toFixed(3));

    const cfg = getPolyClobConfigFromEnv();
    const client = cfg ? createPolyClobClient(cfg) : await getOrCreateDerivedPolyClient();
    const tickSize = (market.orderPriceMinTickSize ? String(market.orderPriceMinTickSize) : '0.01') as '0.01';
    const negRisk = market.negRisk ?? false;
    console.log('[B5 test] Placing $' + TEST_AMOUNT_USD + ' FOK BUY', side, '...');
    const result = await client.createAndPostMarketOrder(
      { tokenID: tokenId, amount: TEST_AMOUNT_USD, side: Side.BUY },
      { tickSize, negRisk },
      OrderType.FOK
    );
    const orderId = (result as { orderID?: string; orderId?: string })?.orderID ?? (result as { orderId?: string })?.orderId;
    if (orderId) {
      console.log('[B5 test] Order placed:', orderId);
    } else {
      console.log('[B5 test] Raw result:', JSON.stringify(result));
    }
  });
}


main().catch((e) => {
  console.error(e);
  process.exit(1);
});
