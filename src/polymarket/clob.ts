/**
 * Polymarket CLOB order placement via @polymarket/clob-client.
 * Polygon RPC (signer/nonce) uses POLYGON_RPC_URL (e.g. Alchemy) to avoid rate limits.
 * Order HTTP requests use HTTP_PROXY/HTTPS_PROXY only when placing the order.
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
 * Build CLOB client from env or explicit config.
 * Requires: POLYMARKET_PRIVATE_KEY, POLYMARKET_FUNDER, POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE.
 * Optional: HTTP_PROXY and HTTPS_PROXY (set in restricted regions; omit in e.g. Amsterdam to call CLOB directly).
 */
export function getPolyClobConfigFromEnv(): PolyClobConfig {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const funder = process.env.POLYMARKET_FUNDER;
  const apiKey = process.env.POLYMARKET_API_KEY;
  const apiSecret = process.env.POLYMARKET_API_SECRET;
  const apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE;
  if (!privateKey || !funder || !apiKey || !apiSecret || !apiPassphrase) {
    throw new Error(
      'Missing Polymarket env: POLYMARKET_PRIVATE_KEY, POLYMARKET_FUNDER, POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE'
    );
  }
  return {
    privateKey: privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`,
    funder,
    apiKey,
    apiSecret,
    apiPassphrase,
  };
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
    config.funder
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
