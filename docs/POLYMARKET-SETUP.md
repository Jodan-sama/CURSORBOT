# Polymarket setup (what you need)

To turn on Polymarket trading alongside Kalshi, you need these **five env vars** on the droplet (and in `.env` locally if you run the bot there). The bot only uses Polymarket when **ENABLE_POLYMARKET=true** and all of these are set.

---

## 1. Wallet (Polygon)

- **POLYMARKET_PRIVATE_KEY** – The **private key** of the wallet you use for Polymarket (hex string, with or without `0x`). This is the same wallet that holds your Polymarket balance and signs orders.
- **POLYMARKET_FUNDER** – The **address** of that wallet (your Polymarket profile/funder address, where USDC is held for trading).

You can get the private key from the wallet you use with Polymarket (e.g. MetaMask: Account menu → Account details → Export Private Key). **Never share or commit this key.**

---

## 2. Polymarket CLOB API credentials

The CLOB (Central Limit Order Book) API needs API key auth. You need to create these in Polymarket’s UI:

- **POLYMARKET_API_KEY**
- **POLYMARKET_API_SECRET**
- **POLYMARKET_API_PASSPHRASE**

**Where to get them:** Log in at [polymarket.com](https://polymarket.com) → **Profile/Settings** → look for **API** or **Developer** or **Trading API**. Create a new API key; Polymarket will show the key, secret, and passphrase once. Store them in `.env` on the droplet and keep them secret.

If you can’t find the API section, check Polymarket’s help or docs; the exact menu name can change.

---

## 3. Enable Polymarket on the bot

On the droplet (and anywhere you run the bot), set:

```bash
ENABLE_POLYMARKET=true
```

If this is missing or not `true`, the bot trades **Kalshi only**.

---

## 4. Proxy (only if needed)

Polymarket may restrict access from some regions/IPs. If the bot is in a **restricted region** (e.g. certain countries), CLOB requests can fail unless they go through a proxy.

- If the droplet is in a **non‑restricted region** (e.g. Amsterdam, as in your setup), you can **omit** proxy env vars and the bot will call the CLOB directly.
- If you see CLOB/order errors that look like geo or access restrictions, set **HTTP_PROXY** and **HTTPS_PROXY** to the same proxy URL (e.g. Proxy Empire). See `docs/polymarket-api.md` for the format.

---

## 5. Optional: Polygon RPC

The CLOB client uses the wallet to sign. If you hit rate limits or need a specific RPC:

```bash
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
```

Otherwise the client uses a default public RPC.

---

## Checklist

| Item | Env var | Where to get it |
|------|--------|------------------|
| Wallet private key | `POLYMARKET_PRIVATE_KEY` | Export from the wallet you use on Polymarket (e.g. MetaMask). |
| Wallet address | `POLYMARKET_FUNDER` | Same wallet’s address (Polymarket profile/funder). |
| API key | `POLYMARKET_API_KEY` | Polymarket → Profile/Settings → API (or Developer / Trading API). |
| API secret | `POLYMARKET_API_SECRET` | Same place as API key (shown once when you create the key). |
| API passphrase | `POLYMARKET_API_PASSPHRASE` | Same place as API key. |
| Turn on Poly | `ENABLE_POLYMARKET=true` | Set in `.env` on the droplet. |

After you set these on the droplet and restart the bot (`systemctl restart cursorbot`), the bot will place orders on both Kalshi and Polymarket when conditions are met (same spread/winning-side logic: it only buys the winning side on Poly too).
