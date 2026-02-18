/**
 * One-off: place a minimal test limit order on current BTC 15m using B123c wallet env.
 * Usage on D2: DOTENV_CONFIG_PATH=/root/cursorbot/.env.b123c node dist/scripts/place-b123c-test-order.js
 */
import 'dotenv/config';

import { getCurrentPolySlug } from '../clock.js';
import { getPolyMarketBySlug } from '../polymarket/gamma.js';
import {
  getOrCreateDerivedPolyClient,
  createAndPostPolyOrder,
  type CreatePolyOrderParams,
} from '../polymarket/clob.js';

const ASSET = 'BTC';
const TEST_PRICE = 0.01;
const TEST_SIZE = 5; // Polymarket min size for this market

async function main() {
  const now = new Date();
  const slug = getCurrentPolySlug(ASSET, now);
  console.log('[B123c test] Current BTC 15m slug:', slug);

  const parsed = await getPolyMarketBySlug(slug);
  const tickSize = (parsed.orderPriceMinTickSize ?? '0.01') as CreatePolyOrderParams['tickSize'];
  const side: 'yes' | 'no' = 'yes';
  const tokenId = side === 'yes' ? parsed.clobTokenIds[0] : parsed.clobTokenIds[1];
  if (!tokenId) throw new Error('No tokenId');

  const params: CreatePolyOrderParams = {
    tokenId,
    price: TEST_PRICE,
    size: TEST_SIZE,
    tickSize,
    negRisk: parsed.negRisk,
  };
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
