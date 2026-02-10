# Spread % and price sources

## Kalshi

- **Strike:** We **default to the ticker** (exact for the contract): the ticker suffix is the strike in **dollars, no decimals** (e.g. `KXSOL15M-26FEB101445-84` → 84). If the ticker strike is missing or outside our “reasonable” range, we use `market.floor_strike` from Kalshi `GET /markets/{ticker}`. Same API load either way (we already fetch the market for yes_bid). Floor_strike can be wrong under load (e.g. 15 for SOL), so ticker-first avoids that.
- **Reasonable ranges:** BTC 1k–500k, ETH 100–100k, SOL 20–10k (avoids bogus values like 15 for SOL).
- **Current price:** We **always prefer Binance** (more accurate). Only use CoinGecko when Binance is unavailable (e.g. 451 geo-block). Spread is `(price - strike) / price * 100`.

## Polymarket

- **Strike / floor:** We checked the **Gamma API** (event by slug) and **CLOB** docs: neither exposes a numeric “strike” or “floor” for 15m Up/Down crypto markets. Gamma gives `outcomePrices`, `clobTokenIds`, `endDate`, etc., but no reference price. Resolution uses an internal reference that isn’t in the public REST APIs.
- **Current price:** Polymarket has **RTDS** (WebSocket) for crypto prices; no REST “current price” for our tick loop.
- **Current behavior:** We use the **same** spread as Kalshi for Poly: **current price** from Binance (or CoinGecko fallback) and **strike** from Kalshi (ticker or `floor_strike`). So when Kalshi is unavailable we don’t place on Poly either for that asset (we need the strike to compute spread/side). If Polymarket ever exposes a strike/reference for 15m in Gamma or CLOB, we could switch Poly to use it and trade Poly independently of Kalshi.
