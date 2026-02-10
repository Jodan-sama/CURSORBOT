# Kalshi API Reference (15M Crypto Markets)

## Auth (authenticated endpoints)

- **Key ID:** `KALSHI_KEY_ID` (UUID from API key creation).
- **Private key:** `KALSHI_PRIVATE_KEY` – RSA PEM (in `.env` use `\n` for newlines).
- Headers: `KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-TIMESTAMP`, `KALSHI-ACCESS-SIGNATURE`.
- Signature: RSA-PSS SHA256 of `timestamp + method + path` (path without query), then base64.

## Base URL
- Production: `https://api.elections.kalshi.com/trade-api/v2`
- Demo: `https://demo-api.kalshi.co/trade-api/v2`

## Ticker Format

```
KXBTC15M-YYMMDDHHMM-SS
├── KXBTC15M = Series (KX=Kalshi Crypto, BTC=asset, 15M=15-min)
├── YYMMDDHHMM = Expiration datetime (UTC)
└── SS = Strike price (in dollars, without decimals)
```

**Examples:**
- `KXBTC15M-26FEB091445-45` = BTC, expires Feb 9 14:45 UTC, strike $45 (example; real strikes are full price e.g. 97000)
- `KXBTC15M-26FEB091600-97000` = BTC, expires Feb 9 16:00 UTC, strike $97,000

**Series tickers:** `KXBTC15M`, `KXETH15M`, `KXSOL15M`

## Strike Price Source

- **Default: ticker.** The ticker encodes the strike in the suffix: `KXBTC15M-26FEB091445-97000` → **97000** (dollars, no decimals). So the **ticker is exact** for the contract. We use it first when it’s in a sane range (BTC 1k–500k, ETH 100–100k, SOL 20–10k).
- **Fallback: floor_strike.** From Kalshi `GET /markets/{ticker}` → `market.floor_strike`. Used when ticker is missing or outside range. Same API load (we already fetch the market for yes_bid); floor_strike can be wrong under load (e.g. 15 for SOL), so ticker-first avoids that.
- **List endpoint** `GET /markets?series_ticker=KXBTC15M` → `floor_strike` is often `null` (unreliable).
- We resolve the **current window** by matching `expected_expiration_time` to the current 15m window end (with a 1‑minute tolerance) so we don’t use the next or previous window’s market.

## Current Price Source (for spread %)

- **Kalshi does not expose** the live reference/index price (CF Benchmarks BRTI, etc.) in the public API. Settlement uses that index; we don’t have it for pre-trade spread.
- **We use Binance** as the “current price” for spread when available. If Binance returns **451** (geo-block) or fails, we **fall back to CoinGecko** (`api.coingecko.com/api/v3/simple/price`). So spread % is `(price - floor_strike) / price * 100`. If Kalshi adds a reference-price endpoint we can switch.

## When we fetch price and compute spread

- **Once per tick, per asset:** At the start of each bot tick we call Binance for current price and Kalshi for the market’s `floor_strike`, then compute signed spread. We do **not** call Binance again right before each order; any orders placed in that same tick (Kalshi and/or Polymarket) use that tick’s price and spread. Ticks run every 5s in B1, so the price is at most a few seconds old when we place.

## Spread Calculation

```
strike_spread_pct = |current_price - strike| / current_price * 100
```

Used for entry rules (bot enters only when market is **outside** the range):
- B1: must be outside ±0.21% (BTC), ±0.23% (ETH), ±0.27% (SOL) — e.g. enter at 0.23%, not at 0.12%
- B2: must be outside ±0.57% (BTC), ±0.57% (ETH), ±0.62% (SOL)
- B3: must be outside ±1% (all assets)
