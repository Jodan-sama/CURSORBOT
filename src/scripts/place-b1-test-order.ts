/**
 * One-off: place a $1 limit order on the current 15m BTC Polymarket, winning side (B1 wallet).
 * Uses .env (POLYMARKET_*, derive, HTTPS_PROXY). Run on D1:
 *   cd /root/cursorbot && node dist/scripts/place-b1-test-order.js
 */
import 'dotenv/config';
import { getCurrentPolySlug } from '../clock.js';
import { getPolyMarketBySlug } from '../polymarket/gamma.js';
import { getOrCreateDerivedPolyClient } from '../polymarket/clob.js';
import { Side, OrderType } from '@polymarket/clob-client';

const ASSET = 'BTC';
const TEST_AMOUNT_USD = 1;
const LIMIT_PRICE = 0.97;

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
  const slug = getCurrentPolySlug(ASSET, now);
  console.log('[B1 test] 15m BTC slug:', slug);

  await withPolyProxy(async () => {
    const market = await getPolyMarketBySlug(slug);
    if (!market) {
      console.error('[B1 test] Market not found');
      process.exit(1);
    }
    const prices = market.outcomePrices ?? ['0.5', '0.5'];
    const yesPrice = typeof prices[0] === 'string' ? parseFloat(prices[0]) : prices[0];
    const noPrice = typeof prices[1] === 'string' ? parseFloat(prices[1]) : prices[1];
    const side: 'yes' | 'no' = yesPrice >= noPrice ? 'yes' : 'no';
    const tokenId = side === 'yes' ? market.clobTokenIds?.[0] : market.clobTokenIds?.[1];
    if (!tokenId) {
      console.error('[B1 test] No token for', side);
      process.exit(1);
    }
    const minShares = market.orderMinSize ?? 5;
    const shares = Math.max(minShares, Math.ceil(TEST_AMOUNT_USD / LIMIT_PRICE));
    const tickSize = (market.orderPriceMinTickSize ? String(market.orderPriceMinTickSize) : '0.01') as '0.01';
    const negRisk = market.negRisk ?? false;
    console.log('[B1 test] Winning side:', side, '| yes=', yesPrice.toFixed(3), 'no=', noPrice.toFixed(3), '| limit', LIMIT_PRICE, 'shares', shares);

    const client = await getOrCreateDerivedPolyClient();
    console.log('[B1 test] Placing $' + TEST_AMOUNT_USD + ' GTC limit BUY', side, '...');
    const result = await client.createAndPostOrder(
      { tokenID: tokenId, price: LIMIT_PRICE, size: shares, side: Side.BUY },
      { tickSize, negRisk },
      OrderType.GTC
    );
    const orderId = (result as { orderID?: string; orderId?: string })?.orderID ?? (result as { orderId?: string })?.orderId;
    if (orderId) {
      console.log('[B1 test] Order placed:', orderId);
    } else {
      console.log('[B1 test] Raw result:', JSON.stringify(result));
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
