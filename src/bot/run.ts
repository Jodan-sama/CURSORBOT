/**
 * Entry point for the long-running bot. Loads env and starts the loop.
 * If HTTP_PROXY/HTTPS_PROXY are set, bootstrap global-agent so CLOB (and other HTTP) use the proxy.
 */
import 'dotenv/config';

if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '';
  const { ProxyAgent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new ProxyAgent(proxy));
}

import { startBotLoop } from './runner.js';

function isPolymarketEnabled(): boolean {
  const v = process.env.ENABLE_POLYMARKET?.trim().toLowerCase();
  return v === 'true' || v === '1';
}

const venue = isPolymarketEnabled() ? 'Kalshi + Polymarket' : 'Kalshi only';
console.log(`Cursorbot starting (B1/B2/B3, ${venue})`);
startBotLoop();
