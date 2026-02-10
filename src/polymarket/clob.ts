/**
 * Polymarket CLOB order placement via @polymarket/clob-client.
 * All Polymarket: Polygon RPC uses POLYGON_RPC_URL (Alchemy); HTTP (Gamma + CLOB) uses proxy when set. Callers run both inside the same proxy context.
 */

import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import {
  ClobClient,
  Side,
  OrderType,
  type ApiKeyCreds,
  type UserOrder,
  type CreateOrderOptions,
} from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import type { ParsedPolyMarket } from './types.js';

const CLOB_HOST = 'https://clob.polymarket.com';

/** Default Alchemy Polygon RPC; set POLYGON_RPC_URL in .env to use your key (reduces rate limits). */
const DEFAULT_POLYGON_RPC = 'https://polygon-mainnet.g.alchemy.com/v2/J6wjUKfJUdYzPD5QNDd-i';

const VALID_TICK_SIZES = ['0.1', '0.01', '0.001', '0.0001'] as const;
type TickSize = (typeof VALID_TICK_SIZES)[number];

function toTickSize(value?: number): CreateOrderOptions['tickSize'] {
  if (value == null) return '0.001';
  const s = String(value);
  return (VALID_TICK_SIZES.includes(s as TickSize) ? s : '0.001') as CreateOrderOptions['tickSize'];
}
const CHAIN_ID = 137; // Polygon
const SIGNATURE_TYPE = 2; // API key auth

export interface PolyClobConfig {
  /** Wallet private key (hex, with or without 0x) */
  privateKey: string;
  /** Polymarket profile/funder address */
  funder: string;
  /** API key creds from Polymarket */
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
}

export interface CreatePolyOrderParams {
  /** YES token ID from Gamma market clobTokenIds[0] */
  tokenId: string;
  /** Price 0–1 (e.g. 0.97) */
  price: number;
  /** Size in USDC/contracts (min often 5) */
  size: number;
  /** From Gamma market orderPriceMinTickSize, e.g. "0.001" */
  tickSize?: CreateOrderOptions['tickSize'];
  /** From Gamma market negRisk */
  negRisk?: boolean;
}

/**
 * Whether to derive API key from wallet (recommended by Polymarket). Set POLYMARKET_DERIVE_KEY=true and omit API_KEY/SECRET/PASSPHRASE.
 */
export function useDerivedPolyKey(): boolean {
  return process.env.POLYMARKET_DERIVE_KEY?.trim().toLowerCase() === 'true';
}

/**
 * Build CLOB client from env or explicit config.
 * Requires: POLYMARKET_PRIVATE_KEY, POLYMARKET_FUNDER.
 * Prefer static L2 keys when set: POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE.
 * If those three are present we use them (no derive). If omitted and POLYMARKET_DERIVE_KEY=true we derive.
 */
export function getPolyClobConfigFromEnv(): PolyClobConfig | null {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY?.trim();
  const funder = process.env.POLYMARKET_FUNDER?.trim();
  if (!privateKey || !funder) {
    throw new Error('Missing Polymarket env: POLYMARKET_PRIVATE_KEY, POLYMARKET_FUNDER');
  }
  const apiKey = process.env.POLYMARKET_API_KEY?.trim();
  const apiSecret = process.env.POLYMARKET_API_SECRET?.trim();
  const apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE?.trim();
  if (apiKey && apiSecret && apiPassphrase) {
    return { privateKey: privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`, funder, apiKey, apiSecret, apiPassphrase };
  }
  if (useDerivedPolyKey()) return null;
  throw new Error(
    'Missing Polymarket env: set POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE (static L2 keys from Builder UI), or POLYMARKET_DERIVE_KEY=true to derive from wallet'
  );
}

let cachedDerivedClient: ClobClient | null = null;

/**
 * Create CLOB client using API key derived from the wallet (createOrDeriveApiKey). Call this inside withPolyProxy. Caches the client for the process.
 */
export async function getOrCreateDerivedPolyClient(): Promise<ClobClient> {
  if (cachedDerivedClient) return cachedDerivedClient;
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY?.trim();
  const funder = process.env.POLYMARKET_FUNDER?.trim();
  if (!privateKey || !funder) {
    throw new Error('Missing POLYMARKET_PRIVATE_KEY or POLYMARKET_FUNDER for derive mode');
  }
  const rpcUrl = process.env.POLYGON_RPC_URL?.trim() || DEFAULT_POLYGON_RPC;
  const provider = new JsonRpcProvider(rpcUrl);
  const signer = new Wallet(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`, provider);
  const clientNoCreds = new ClobClient(
    CLOB_HOST,
    CHAIN_ID as 137,
    signer,
    undefined,
    SIGNATURE_TYPE as SignatureType,
    funder,
    undefined,
    true
  );
  const normalizeCreds = (raw: Record<string, unknown> | null): { key: string; secret: string; passphrase: string } | null => {
    if (!raw || typeof raw !== 'object') return null;
    const key = (raw.key ?? raw.apiKey ?? (raw as Record<string, unknown>).api_key) as string | undefined;
    const secret = (raw.secret ?? (raw as Record<string, unknown>).api_secret) as string | undefined;
    const passphrase = (raw.passphrase ?? (raw as Record<string, unknown>).api_passphrase) as string | undefined;
    if (key && secret && passphrase) return { key, secret, passphrase };
    return null;
  };
  // Try derive first (get existing key); if empty or fails, try create (generate new key). Call inside withPolyProxy.
  let creds: { key: string; secret: string; passphrase: string } | null = null;
  try {
    const rawDerive = await clientNoCreds.deriveApiKey();
    creds = normalizeCreds(rawDerive as unknown as Record<string, unknown>);
  } catch {
    // derive failed (e.g. no key yet); try create
  }
  if (!creds?.key || !creds?.secret || !creds?.passphrase) {
    try {
      const rawCreate = await clientNoCreds.createApiKey();
      creds = normalizeCreds(rawCreate as unknown as Record<string, unknown>);
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? '';
      throw new Error(`derive returned no creds and createApiKey failed: status=${status} ${msg}`);
    }
  }
  if (!creds?.key || !creds?.secret || !creds?.passphrase) {
    throw new Error('derive/create API key did not return key/secret/passphrase (check funder address and signature type at polymarket.com/settings)');
  }
  cachedDerivedClient = new ClobClient(
    CLOB_HOST,
    CHAIN_ID as 137,
    signer,
    creds,
    SIGNATURE_TYPE as SignatureType,
    funder,
    undefined,
    true
  );
  return cachedDerivedClient;
}

/**
 * Create a CLOB client. Signer uses POLYGON_RPC_URL (e.g. Alchemy) for RPC. Set proxy before placing order.
 */
export function createPolyClobClient(config: PolyClobConfig): ClobClient {
  const rpcUrl = process.env.POLYGON_RPC_URL?.trim() || DEFAULT_POLYGON_RPC;
  const provider = new JsonRpcProvider(rpcUrl);
  const signer = new Wallet(config.privateKey, provider);
  const creds: ApiKeyCreds = {
    key: config.apiKey,
    secret: config.apiSecret,
    passphrase: config.apiPassphrase,
  };
  return new ClobClient(
    CLOB_HOST,
    CHAIN_ID as 137,
    signer,
    creds,
    SIGNATURE_TYPE as SignatureType,
    config.funder,
    undefined, // geoBlockToken
    true // useServerTime: use Polymarket server time for L2 signing to avoid 401 from clock skew
  );
}

/**
 * Place a GTC limit order on Polymarket (BUY YES at given price).
 * Size is in number (e.g. 5); CLOB accepts number, min often 5.
 */
export async function createAndPostPolyOrder(
  client: ClobClient,
  params: CreatePolyOrderParams
): Promise<{ orderID?: string; status?: string; [k: string]: unknown }> {
  const tickSize: CreateOrderOptions['tickSize'] =
    params.tickSize ?? '0.001';
  const options: Partial<CreateOrderOptions> = {
    tickSize,
    negRisk: params.negRisk ?? false,
  };
  const userOrder: UserOrder = {
    tokenID: params.tokenId,
    price: params.price,
    size: params.size,
    side: Side.BUY,
  };
  const result = await client.createAndPostOrder(
    userOrder,
    options,
    OrderType.GTC
  );
  return result as { orderID?: string; status?: string; [k: string]: unknown };
}

/**
 * Build order params from a parsed Gamma market.
 * side: 'yes' = first outcome (Up), 'no' = second outcome (Down). We only buy the winning side.
 */
export function orderParamsFromParsedMarket(
  parsed: ParsedPolyMarket,
  price: number,
  size: number,
  side: 'yes' | 'no' = 'yes'
): CreatePolyOrderParams {
  const tokenId = side === 'yes' ? parsed.clobTokenIds[0] : parsed.clobTokenIds[1];
  if (!tokenId) throw new Error(`Market has no ${side.toUpperCase()} token`);
  return {
    tokenId,
    price,
    size,
    tickSize: toTickSize(parsed.orderPriceMinTickSize),
    negRisk: parsed.negRisk,
  };
}
