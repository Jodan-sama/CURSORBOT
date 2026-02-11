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

export interface KalshiOrderRow {
  order_id: string;
  ticker: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  type: string;
  status: string;
  yes_price?: number;
  no_price?: number;
  fill_count: number;
  remaining_count: number;
  initial_count: number;
  [key: string]: unknown;
}

export interface KalshiOrderResponse {
  order?: KalshiOrderRow;
}

export interface KalshiGetOrdersResponse {
  orders: KalshiOrderRow[];
  cursor?: string;
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
    // Kalshi requires exactly one of yes_price, no_price, yes_price_dollars, no_price_dollars.
    if (params.side === 'yes') {
      body.yes_price = params.yes_price ?? 50;
    } else {
      body.no_price = params.no_price ?? 50;
    }
  }
  return kalshiFetch<KalshiOrderResponse>('/portfolio/orders', {
    method: 'POST',
    body,
  });
}

/**
 * Get a single order by ID.
 */
export async function getKalshiOrder(orderId: string): Promise<KalshiOrderRow | null> {
  const res = await kalshiFetch<KalshiOrderResponse>(`/portfolio/orders/${orderId}`, { method: 'GET' });
  return res.order ?? null;
}

/**
 * List orders, optionally filtered by ticker. Status: resting | canceled | executed.
 */
export async function getKalshiOrders(params: { ticker?: string; status?: string; limit?: number } = {}): Promise<KalshiOrderRow[]> {
  const q = new URLSearchParams();
  if (params.ticker) q.set('ticker', params.ticker);
  if (params.status) q.set('status', params.status);
  if (params.limit != null) q.set('limit', String(params.limit));
  const query = q.toString();
  const path = query ? `/portfolio/orders?${query}` : '/portfolio/orders';
  const res = await kalshiFetch<KalshiGetOrdersResponse>(path, { method: 'GET' });
  return res.orders ?? [];
}

/**
 * Cancel a resting order (DELETE). Remaining contracts are canceled.
 */
export async function cancelKalshiOrder(orderId: string): Promise<KalshiOrderRow | null> {
  const res = await kalshiFetch<{ order: KalshiOrderRow; reduced_by?: number }>(`/portfolio/orders/${orderId}`, {
    method: 'DELETE',
  });
  return (res as { order?: KalshiOrderRow }).order ?? null;
}
