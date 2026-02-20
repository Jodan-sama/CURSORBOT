/**
 * One-off: place a small test limit order on current BTC 15m, winning side, using B123c wallet env.
 * Usage on D2: cd /root/cursorbot && node dist/scripts/place-b123c-test-order.js
 * Loads .env then .env.b123c (override) so the order goes to the B123c wallet, same as cursorbot-b123c service.
 */
import { config } from 'dotenv';
config(); // .env (proxy, RPC)
config({ path: '.env.b123c', override: true }); // B123c wallet (overrides POLYMARKET_* when present)

import { getCurrentPolySlug } from '../clock.js';
import { getPolyMarketBySlug } from '../polymarket/gamma.js';
import {
  getOrCreateDerivedPolyClient,
  createAndPostPolyOrder,
  type CreatePolyOrderParams,
} from '../polymarket/clob.js';

const ASSET = 'BTC';
const LIMIT_PRICE = 0.97;

async function main() {
  const now = new Date();
  const slug = getCurrentPolySlug(ASSET, now);
  console.log('[B123c test] Current BTC 15m slug:', slug);

  const parsed = await getPolyMarketBySlug(slug);
  const prices = parsed.outcomePrices ?? ['0.5', '0.5'];
  const yesPrice = typeof prices[0] === 'string' ? parseFloat(prices[0]) : prices[0];
  const noPrice = typeof prices[1] === 'string' ? parseFloat(prices[1]) : prices[1];
  const side: 'yes' | 'no' = yesPrice >= noPrice ? 'yes' : 'no';
  const tokenId = side === 'yes' ? parsed.clobTokenIds[0] : parsed.clobTokenIds[1];
  if (!tokenId) throw new Error('No tokenId');

  const minShares = parsed.orderMinSize ?? 5;
  const shares = Math.max(minShares, Math.ceil(5 / LIMIT_PRICE)); // ~$5 notional
  const tickSize = (parsed.orderPriceMinTickSize != null ? String(parsed.orderPriceMinTickSize) : '0.01') as CreatePolyOrderParams['tickSize'];
  const params: CreatePolyOrderParams = {
    tokenId,
    price: LIMIT_PRICE,
    size: shares,
    tickSize,
    negRisk: parsed.negRisk,
  };
  console.log('[B123c test] Winning side:', side, '| yes=', yesPrice.toFixed(3), 'no=', noPrice.toFixed(3), '| limit', LIMIT_PRICE, 'shares', shares);
  console.log('[B123c test] Params:', { ...params, tokenId: tokenId.slice(0, 24) + '…' });

  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '';
  if (!proxy) console.warn('[B123c test] No proxy set');

  const run = async () => {
    const client = await getOrCreateDerivedPolyClient();
    const result = await createAndPostPolyOrder(client, params);
    return result;
  };

  const result = proxy
    ? await (async () => {
        const axios = (await import('axios')).default;
        const { HttpsProxyAgent } = await import('https-proxy-agent');
        const undici = await import('undici');
        const prev = undici.getGlobalDispatcher();
        try {
          undici.setGlobalDispatcher(new undici.ProxyAgent(proxy));
          axios.defaults.httpsAgent = new (await import('https-proxy-agent')).HttpsProxyAgent(proxy);
          axios.defaults.proxy = false;
          return await run();
        } finally {
          undici.setGlobalDispatcher(prev);
        }
      })()
    : await run();

  console.log('[B123c test] Result:', result);
  if (result.orderID) {
    console.log('[B123c test] Order placed: orderID=', result.orderID, '| Cancel on Polymarket when done.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
