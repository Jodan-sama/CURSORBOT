/**
 * Kalshi order placement (authenticated).
 */

import { kalshiFetch } from './auth.js';

export interface CreateKalshiOrderParams {
  ticker: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  count: number;
  type: 'limit' | 'market';
  yes_price?: number; // 1-99 for limit
  no_price?: number;
}

export interface KalshiOrderResponse {
  order?: {
    order_id: string;
    ticker: string;
    status: string;
    yes_price?: number;
    no_price?: number;
    [key: string]: unknown;
  };
}

/**
 * Create an order on Kalshi. For limit: yes_price (1-99) required. For market, type "market" and no price.
 */
export async function createKalshiOrder(params: CreateKalshiOrderParams): Promise<KalshiOrderResponse> {
  const body: Record<string, unknown> = {
    ticker: params.ticker,
    side: params.side,
    action: params.action,
    count: params.count,
    type: params.type,
  };
  if (params.type === 'limit') {
    body.yes_price = params.yes_price ?? 50;
    body.no_price = params.no_price ?? 100 - (params.yes_price ?? 50);
  }
  return kalshiFetch<KalshiOrderResponse>('/portfolio/orders', {
    method: 'POST',
    body,
  });
}
