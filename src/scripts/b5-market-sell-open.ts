/**
 * One-off: market sell all open B5 positions for the wallet.
 * Uses Data API to list positions (redeemable=false), then FOK sell each.
 * Run on D3 with same .env as B5: npx tsx src/scripts/b5-market-sell-open.ts
 */

import 'dotenv/config';
import {
  createPolyClobClient,
  getPolyClobConfigFromEnv,
  getOrCreateDerivedPolyClient,
} from '../polymarket/clob.js';
import { Side, OrderType, type ClobClient, type CreateOrderOptions } from '@polymarket/clob-client';

const DATA_API_BASE = 'https://data-api.polymarket.com';

type DataPosition = {
  asset: string;
  size: number;
  redeemable?: boolean;
  title?: string;
  slug?: string;
};

async function withPolyProxy<T>(fn: () => Promise<T>): Promise<T> {
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '';
  if (!proxy) return fn();
  const axios = (await import('axios')).default;
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  const prevUndici = (await import('undici')).getGlobalDispatcher();
  const { setGlobalDispatcher, ProxyAgent } = await import('undici');
  const prevAxiosAgent = axios.defaults.httpsAgent;
  const prevAxiosProxy = axios.defaults.proxy;
  try {
    setGlobalDispatcher(new ProxyAgent(proxy));
    axios.defaults.httpsAgent = new HttpsProxyAgent(proxy);
    axios.defaults.proxy = false;
    return await fn();
  } finally {
    setGlobalDispatcher(prevUndici);
    axios.defaults.httpsAgent = prevAxiosAgent;
    axios.defaults.proxy = prevAxiosProxy;
  }
}

async function getClobClient(): Promise<ClobClient> {
  const cfg = getPolyClobConfigFromEnv();
  return cfg != null ? createPolyClobClient(cfg) : await getOrCreateDerivedPolyClient();
}

async function fetchOpenPositions(user: string): Promise<DataPosition[]> {
  const url = `${DATA_API_BASE}/positions?user=${encodeURIComponent(user)}&limit=100`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Data API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as DataPosition[];
  return data.filter((p) => p.redeemable !== true && p.asset && p.size > 0);
}

async function main(): Promise<void> {
  const wallet =
    process.env.POLYMARKET_PROXY_WALLET?.trim() ||
    process.env.POLYMARKET_FUNDER?.trim() ||
    '';
  if (!wallet) {
    console.error('Set POLYMARKET_PROXY_WALLET or POLYMARKET_FUNDER in .env');
    process.exit(1);
  }

  const open = await fetchOpenPositions(wallet);
  if (open.length === 0) {
    console.log('No open (non-redeemable) positions.');
    return;
  }
  console.log(`Found ${open.length} open position(s). Selling…`);

  await withPolyProxy(async () => {
    const client = await getClobClient();
    for (const pos of open) {
      const tokenId = pos.asset;
      const sellShares = Math.max(1, Math.ceil(pos.size));
      try {
        const tickSize = (await client.getTickSize(tokenId)) as string | undefined;
        const tickSizeOpt = (tickSize != null ? String(tickSize) : '0.01') as CreateOrderOptions['tickSize'];
        const negRisk = await client.getNegRisk(tokenId);
        console.log(`Selling ${sellShares} shares of ${pos.title ?? tokenId.slice(0, 20)}…`);
        const result = await client.createAndPostMarketOrder(
          { tokenID: tokenId, amount: sellShares, side: Side.SELL },
          { tickSize: tickSizeOpt, negRisk },
          OrderType.FOK
        );
        const orderId = (result as { orderID?: string; orderId?: string })?.orderID
          ?? (result as { orderId?: string })?.orderId;
        if (orderId) {
          console.log(`Sold: orderId=${orderId.slice(0, 20)}…`);
        } else {
          console.warn('No orderId:', JSON.stringify(result));
        }
      } catch (e) {
        console.error(`Sell failed for ${pos.title ?? tokenId}:`, e instanceof Error ? e.message : e);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  });
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
