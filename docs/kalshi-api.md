# Kalshi API Reference (15M Crypto Markets)

## Auth (authenticated endpoints)

- **Key ID:** `KALSHI_KEY_ID` (UUID from API key creation).
- **Private key:** `KALSHI_PRIVATE_KEY` – RSA PEM (in `.env` use `\n` for newlines).
- Headers: `KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-TIMESTAMP`, `KALSHI-ACCESS-SIGNATURE`.
- Signature: RSA-PSS SHA256 of `timestamp + method + path` (path without query), then base64.

## Base URL
- Production: `https://api.trade.kalshi.com/trade-api/v2`
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

- **List endpoint** `GET /markets?series_ticker=KXBTC15M` → `floor_strike` is often `null` (unreliable).
- **Detail endpoint** `GET /markets/{ticker}` → use `market.floor_strike` (reliable).
- Use the market detail endpoint per ticker to get `floor_strike`.

## Current Price Source

- **Binance API:** `GET https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT`
- Response field: `price` (string, e.g. `"97234.50"`).

## Spread Calculation

```
strike_spread_pct = |current_price - strike| / current_price * 100
```

Used for entry rules (bot enters only when market is **outside** the range):
- B1: must be outside ±0.21% (BTC), ±0.23% (ETH), ±0.27% (SOL) — e.g. enter at 0.23%, not at 0.12%
- B2: must be outside ±0.57% (BTC), ±0.57% (ETH), ±0.62% (SOL)
- B3: must be outside ±1% (all assets)
