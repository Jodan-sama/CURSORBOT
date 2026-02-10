/**
 * Kalshi API request signing (RSA-PSS SHA256) and authenticated fetch.
 */

import { createPrivateKey, sign as cryptoSign, constants } from 'node:crypto';

const DEFAULT_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

export interface KalshiAuthConfig {
  keyId: string;
  privateKeyPem: string;
  baseUrl?: string;
}

function getAuthFromEnv(): KalshiAuthConfig {
  const keyId = process.env.KALSHI_KEY_ID;
  const pem = process.env.KALSHI_PRIVATE_KEY;
  if (!keyId || !pem) throw new Error('KALSHI_KEY_ID and KALSHI_PRIVATE_KEY required');
  const privateKeyPem = pem.replace(/\\n/g, '\n');
  return {
    keyId,
    privateKeyPem,
    baseUrl: process.env.KALSHI_BASE_URL || DEFAULT_BASE,
  };
}

/**
 * Sign the request: message = timestamp + method + path (path without query).
 * Algorithm: RSA-PSS with SHA-256, then base64.
 */
function signRequest(timestamp: string, method: string, path: string, privateKeyPem: string): string {
  const message = timestamp + method + path;
  const key = createPrivateKey(privateKeyPem);
  const sig = cryptoSign('sha256', Buffer.from(message, 'utf8'), {
    key,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  return sig.toString('base64');
}

export interface KalshiRequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: Record<string, unknown>;
}

/**
 * Make an authenticated request to Kalshi. Path is relative to base (e.g. /portfolio/orders).
 */
export async function kalshiFetch<T = unknown>(
  path: string,
  options: KalshiRequestOptions = {},
  config?: KalshiAuthConfig
): Promise<T> {
  const cfg = config ?? getAuthFromEnv();
  const baseUrl = (cfg.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  const method = options.method ?? 'GET';
  const pathNoQuery = path.indexOf('?') >= 0 ? path.slice(0, path.indexOf('?')) : path;
  const requestPath = pathNoQuery.startsWith('/trade-api/v2') ? pathNoQuery : `/trade-api/v2${pathNoQuery.startsWith('/') ? pathNoQuery : '/' + pathNoQuery}`;
  const fullPath = path.includes('?')
    ? `${baseUrl}${pathNoQuery}${path.slice(path.indexOf('?'))}`
    : `${baseUrl}${pathNoQuery}`;
  const timestamp = String(Date.now());
  const signature = signRequest(timestamp, method, requestPath, cfg.privateKeyPem);

  const headers: Record<string, string> = {
    'KALSHI-ACCESS-KEY': cfg.keyId,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature,
    Accept: 'application/json',
  };

  let body: string | undefined;
  if (options.body) {
    body = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(fullPath, { method, headers, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`Kalshi ${method} ${path}: ${res.status} ${text}`);
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
