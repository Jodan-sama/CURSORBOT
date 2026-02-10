# Spread % and price sources

## Kalshi

- **Strike:** From Kalshi `GET /markets/{ticker}` → `market.floor_strike`.
- **Current price:** Kalshi does **not** expose the live reference price (CF Benchmarks) in the API. We use **Binance** spot (`/api/v3/ticker/price`) as the “current price” for spread. So spread is `(Binance_price - floor_strike) / Binance_price * 100`. If Kalshi ever exposes the reference index, we can switch to that for better accuracy.

## Polymarket

- **Strike / floor:** Polymarket’s Gamma API for 15m events does not expose a numeric “strike” or “floor” in the same way as Kalshi. Markets are binary (Up/Down) with outcome prices.
- **Current price:** Polymarket has **RTDS** (WebSocket) for crypto prices (Binance or Chainlink). There is no simple REST “current BTC price” from Polymarket for our tick loop.
- **Current behavior:** We use the **same** spread as Kalshi (Binance current price + Kalshi floor_strike) for both venues so entry logic is consistent. If we later integrate Polymarket’s own price feed (e.g. RTDS or a REST endpoint) and a way to get a Poly-specific “strike” or reference for 15m, we can compute a Polymarket-only spread and use it when placing Poly orders.
