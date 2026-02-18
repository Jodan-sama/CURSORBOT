/**
 * Kalshi settlements API (authenticated). Used by resolve-kalshi-outcomes to get market_result per ticker.
 */

import { kalshiFetch } from './auth.js';

export interface KalshiSettlement {
  ticker: string;
  event_ticker: string;
  market_result: 'yes' | 'no' | 'scalar' | 'void';
  yes_count: number;
  no_count: number;
  yes_total_cost: number;
  no_total_cost: number;
  revenue: number;
  settled_time: string;
  fee_cost?: string;
  [key: string]: unknown;
}

export interface GetKalshiSettlementsResponse {
  settlements: KalshiSettlement[];
  cursor?: string;
}

/** Fetch settlements (paginated). Optional ticker, min_ts, max_ts, limit, cursor. */
export async function getKalshiSettlements(params: {
  ticker?: string;
  min_ts?: number;
  max_ts?: number;
  limit?: number;
  cursor?: string;
} = {}): Promise<GetKalshiSettlementsResponse> {
  const q = new URLSearchParams();
  if (params.ticker) q.set('ticker', params.ticker);
  if (params.min_ts != null) q.set('min_ts', String(params.min_ts));
  if (params.max_ts != null) q.set('max_ts', String(params.max_ts));
  if (params.limit != null) q.set('limit', String(params.limit));
  if (params.cursor) q.set('cursor', params.cursor);
  const query = q.toString();
  const path = query ? `/portfolio/settlements?${query}` : '/portfolio/settlements';
  return kalshiFetch<GetKalshiSettlementsResponse>(path, { method: 'GET' });
}
