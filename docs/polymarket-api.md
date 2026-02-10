# Polymarket Trading Overview

## 1. Read Market Data (Gamma API)

- **URL:** `https://gamma-api.polymarket.com/events/slug/{market-slug}`
- **Example slug:** `btc-updown-15m-1770671700` (asset-updown-15m-{timestamp}`)

**Response (relevant fields):**

- `markets[]` – one element per binary market:
  - `outcomePrices` – JSON string array, e.g. `["0.475", "0.525"]` (YES then NO)
  - `clobTokenIds` – JSON string array of token IDs for CLOB order placement (YES token first, then NO)
  - `conditionId` – market identifier
  - `endDate`, `startDate` – window times
- Slug pattern for 15M: `{btc|eth|sol}-updown-15m-{unix_timestamp}`

## 2. Place Order (CLOB API via Proxy)

Orders must go through your proxy so the CLOB sees a consistent IP/location.

- **Proxy (Proxy Empire):** Set `HTTP_PROXY` and `HTTPS_PROXY` in env. Format:
  `http://USERNAME:PASSWORD@v2.proxyempire.io:5000`  
  Use one session ID per process (e.g. one sid for the bot). See `.env.example`.
- **CLOB host:** `https://clob.polymarket.com`
- **Chain ID:** 137 (Polygon)
- **Signature type:** 2 (API key auth in your setup)

**Credentials (store in env, never commit):**

- `POLYMARKET_CLOB_KEY` – wallet-derived key (hex)
- `POLYMARKET_FUNDER` – Polymarket profile address (where USDC is)
- `POLYMARKET_API_KEY` / `POLYMARKET_API_SECRET` / `POLYMARKET_API_PASSPHRASE` – API creds from Polymarket

**Order semantics:**

- **Token ID:** From Gamma `clobTokenIds`; use the token for the outcome you’re buying (e.g. first = “Up” = YES).
- **Price:** 0–1 (e.g. 0.97 for 97¢).
- **Size:** String with 2 decimals, e.g. `"5.00"` (min often 5).
- **Side:** BUY.

**Result:** `{ status: 'matched' | 'live', order_id: '...' }` (and similar in TS client).

## 3. Using the Proxy from Node

Set before any CLOB request:

- `HTTP_PROXY` and `HTTPS_PROXY` to your proxy URL.

Node’s built-in `fetch` does not use these. For the CLOB client to use the proxy you can:

- Use a global agent (e.g. `global-agent`) so all `http`/`https` traffic uses the proxy, or
- Use a fetch implementation that supports a proxy (e.g. `undici` with `ProxyAgent`) and pass it into the client if the client allows a custom fetch.

See `src/polymarket/clob.ts` for the app’s CLOB wrapper and env var names.
