/**
 * Gamma API event-by-slug response types.
 * outcomePrices and clobTokenIds are JSON strings in the API response.
 */

export interface GammaMarket {
  id: string;
  question?: string;
  conditionId: string;
  slug: string;
  outcomePrices: string; // JSON array e.g. '["0.475","0.525"]'
  clobTokenIds: string;  // JSON array e.g. '["tokenId1","tokenId2"]'
  outcomes?: string;     // JSON array e.g. '["Up","Down"]'
  endDate?: string;
  endDateIso?: string;
  startDate?: string;
  eventStartTime?: string;
  orderPriceMinTickSize?: number;
  orderMinSize?: number;
  negRisk?: boolean;
  acceptingOrders?: boolean;
  closed?: boolean;
  [key: string]: unknown;
}

export interface GammaEvent {
  id: string;
  ticker: string;
  slug: string;
  title: string;
  description?: string;
  markets: GammaMarket[];
  startTime?: string;
  endDate?: string;
  closed?: boolean;
  [key: string]: unknown;
}

/** Parsed market data for trading (outcomePrices and clobTokenIds as arrays). */
export interface ParsedPolyMarket {
  conditionId: string;
  slug: string;
  outcomePrices: number[];   // [YES, NO] e.g. [0.475, 0.525]
  clobTokenIds: string[];   // [YES_token, NO_token]
  outcomes: string[];        // e.g. ["Up", "Down"]
  orderMinSize?: number;
  orderPriceMinTickSize?: number;
  negRisk?: boolean;
  endDate?: string;
}
