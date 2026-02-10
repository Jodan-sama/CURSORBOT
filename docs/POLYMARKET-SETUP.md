# Polymarket setup (what you need)

To turn on Polymarket trading alongside Kalshi, you need these **five env vars** on the droplet (and in `.env` locally if you run the bot there). The bot only uses Polymarket when **ENABLE_POLYMARKET=true** and all of these are set.

---

## 1. Wallet (Polygon)

- **POLYMARKET_PRIVATE_KEY** – The **private key** of the wallet you use for Polymarket (hex string, with or without `0x`). This is the same wallet that holds your Polymarket balance and signs orders.
- **POLYMARKET_FUNDER** – The **address** of that wallet (your Polymarket profile/funder address, where USDC is held for trading).

You can get the private key from the wallet you use with Polymarket (e.g. MetaMask: Account menu → Account details → Export Private Key). **Never share or commit this key.**

---

## 2. Polymarket CLOB API credentials

You need to create these in the Polymarket UI and set them on the bot:

- **POLYMARKET_API_KEY**
- **POLYMARKET_API_SECRET**
- **POLYMARKET_API_PASSPHRASE**

**Where to get them:** Log in at [polymarket.com](https://polymarket.com) → **Profile** → **Builder Codes** (or Settings → Builder). Under **Builder Keys**, click **+ Create New**. Polymarket shows the **key**, **secret**, and **passphrase only once** — copy and save them immediately, then put them in `.env` on the droplet. Do **not** set `POLYMARKET_DERIVE_KEY` (or set it to `false`); the bot uses these static credentials.


**401 Unauthorized / Invalid api key:** The key must be for **production** (not test) and **tied to the same wallet** as `POLYMARKET_FUNDER`. Ensure `.env` has only **one** set of `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE` (no duplicate lines). The bot trims whitespace and uses Polymarket server time for L2 signing to avoid clock skew.

---

## 3. Enable Polymarket on the bot

On the droplet (and anywhere you run the bot), set:

```bash
ENABLE_POLYMARKET=true
```

If this is missing or not `true`, the bot trades **Kalshi only**.

---

## 4. Proxy (only if needed)

**All Polymarket HTTP runs through the proxy when set:** Gamma API (market data) and CLOB (getTickSize + place order) both use the proxy when `HTTP_PROXY`/`HTTPS_PROXY` are set. Key derive/create calls also go through the proxy when it is set. Polygon RPC (signing) uses **Alchemy** via `POLYGON_RPC_URL` (no proxy, avoids timeouts). **For reliable key setup, prefer manually generated static L2 keys** from the Builder UI; derive can fail if the proxy does not support L1 signing for key endpoints.

- If the droplet is in a **non‑restricted region** (e.g. Amsterdam), **omit** `HTTP_PROXY` and `HTTPS_PROXY`; the bot will call Gamma and CLOB directly.
- If you see redirect/geo errors, set **HTTP_PROXY** and **HTTPS_PROXY**; then every Polymarket HTTP call (Gamma + CLOB) goes through the proxy.

---

## 5. Polygon RPC (Alchemy)

The CLOB client uses the wallet to sign via Polygon RPC. The bot uses **Alchemy** by default (`POLYGON_RPC_URL`). Set your own key to avoid rate limits:

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
| Turn on Poly | `ENABLE_POLYMARKET=true` | Set in `.env` on the droplet. No quotes, no spaces, lowercase `true`. systemd’s `EnvironmentFile` expects plain `KEY=value` lines (no `export`). |

After you set these on the droplet and restart the bot (`systemctl restart cursorbot`), the bot will place orders on both Kalshi and Polymarket when conditions are met (same spread/winning-side logic: it only buys the winning side on Poly too).

---

## What’s next to get Polymarket running

1. **Put all required env vars in the droplet’s `.env`**  
   Edit on the droplet. **If you get “Cannot open file for writing: No such file or directory”:**
   - Find the real repo path: `sudo grep WorkingDirectory /etc/systemd/system/cursorbot.service` (e.g. `WorkingDirectory=/root/cursorbot` or `/opt/cursorbot`).
   - Go there and edit `.env` from inside that directory:
     ```bash
     cd /root/cursorbot
     nano .env
     ```
     (If your service file shows a different path, use that instead of `/root/cursorbot`.)
   - If the repo path doesn’t exist at all, clone the repo there first (see DROPLET-SETUP.md), then create `.env` in that folder.
   Add (or append) these vars:
   - `POLYMARKET_PRIVATE_KEY`
   - `POLYMARKET_FUNDER`
   - `POLYMARKET_API_KEY`
   - `POLYMARKET_API_SECRET`
   - `POLYMARKET_API_PASSPHRASE`
   - `ENABLE_POLYMARKET=true`  
   (Optional: `POLYGON_RPC_URL` if you use Alchemy/other. Proxy only if the droplet is in a restricted region.)

2. **Restart the bot** (on the droplet):
   ```bash
   sudo systemctl restart cursorbot
   ```

3. **Confirm it’s running**  
   - `sudo systemctl status cursorbot` → should be `active (running)`.
   - `sudo journalctl -u cursorbot -f` → when a window hits, you should see lines like `B1 Poly BTC orderId=…` or `B2 Poly ETH orderId=…` if Poly is placing orders. Kalshi lines look like `B1 Kalshi BTC …`.

4. **Check the dashboard**  
   Recent positions should show some with **exchange: polymarket** and order IDs. Any Poly-related errors will appear under “Recent errors”.
