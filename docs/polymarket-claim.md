# Claiming winnings on Polymarket

After a market resolves, winning conditional tokens can be **redeemed** for USDC by calling the CTF (Conditional Token Framework) contract on Polygon.

## How it works

Polymarket’s docs: [Redeeming Tokens](https://docs.polymarket.com/developers/CTF/redeem).

- Once the condition has **payouts reported** (via UMA/CTF adapter), holders of the winning outcome can call **`redeemPositions`** on the CTF contract.
- That **burns** the winning conditional tokens and credits the underlying collateral (USDC) to your wallet.

---

## Setup: .env and cron (step-by-step)

Do this on the **droplet** (the server where CURSORBOT runs). You need your **wallet address** and **private key** (e.g. from Polygun). **Never paste your private key in chat or commit it to git** — only put it in `.env` on the server.

### 1. SSH into the droplet

From your Mac (in Terminal):

```bash
ssh root@YOUR_DROPLET_IP
```

Use the same IP you use for the main bot (e.g. from `docs/CHECK-BOT-AND-LOGS.md`). If you use a key file:

```bash
ssh -i /path/to/your/key root@YOUR_DROPLET_IP
```

### 2. Open the .env file

```bash
cd /root/cursorbot
nano .env
```

If `.env` doesn’t exist yet, the same command will create it when you save.

### 3. Add these line items

Add one line per variable. **No spaces around the `=`**. Replace the placeholder values with your real ones.

| Variable | What to put | Example (fake) |
|----------|-------------|-----------------|
| `POLYMARKET_PRIVATE_KEY` | Your wallet’s private key (hex, with or without `0x`) | `POLYMARKET_PRIVATE_KEY=0xabc123...` or `POLYMARKET_PRIVATE_KEY=abc123...` |
| `POLYMARKET_FUNDER` | The **same wallet’s address** (0x...) — used to find redeemable positions | `POLYMARKET_FUNDER=0x1234567890abcdef...` |
| `POLYGON_RPC_URL` | A Polygon RPC URL (for sending the claim tx). Free option: [Alchemy](https://www.alchemy.com/) → create app → Polygon Mainnet → copy HTTPS URL | `POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY` |
| `POLYMARKET_PROXY_WALLET` | **(Optional)** If positions don’t show up, your app (e.g. PolyGun) may hold them in a **proxy wallet**. Set this to that proxy address (0x...) so the script also looks up positions for it. You still need the **private key for the wallet that holds the tokens** (proxy or EOA) to redeem. | `POLYMARKET_PROXY_WALLET=0x...` |

**Example block to paste (then replace the values):**

```env
POLYMARKET_PRIVATE_KEY=0xYourPrivateKeyHexNoSpaces
POLYMARKET_FUNDER=0xYourWalletAddress
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YourAlchemyApiKey
```

- **POL** (MATIC): The wallet needs a small amount of POL on Polygon to pay gas. Send POL to `POLYMARKET_FUNDER` if needed.
- **Proxy (optional):** If the droplet is in a region that blocks Polymarket’s API, add:
  ```env
  HTTPS_PROXY=http://your-proxy:port
  ```

### 4. Save and exit nano

- **Save:** `Ctrl+O`, then `Enter`.
- **Exit:** `Ctrl+X`.

### 5. Build the project (so the claim script is compiled)

```bash
cd /root/cursorbot
npm run build
```

### 6. Install the cron job (runs every ~15 minutes)

```bash
crontab -e
```

If asked, choose `nano`. Add this **single line** at the end of the file (replace with your path if different):

```
5,20,35,50 * * * * cd /root/cursorbot && /usr/bin/node dist/scripts/claim-polymarket.js
```

Save (`Ctrl+O`, `Enter`) and exit (`Ctrl+X`).  
Cron will run the script at **:05, :20, :35, :50** every hour (~ every 15 minutes).

### 7. Test once by hand

```bash
cd /root/cursorbot && node dist/scripts/claim-polymarket.js
```

You should see either “Discovering redeemable positions…” and then “Redeemed: …” for each, or “No condition IDs to redeem…” if there’s nothing to claim yet.

---

## In-repo claim script (auto-discovery)

The script uses `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_FUNDER`, and `POLYGON_RPC_URL` from `.env`. With no arguments and no `CONDITION_IDS`, it **automatically discovers redeemable positions** for that wallet via the Polymarket Data API and redeems each one.

**Optional:** To redeem only specific markets, set `CONDITION_IDS=id1,id2` in `.env` or pass condition IDs as arguments. **Manual:** Claim from the Polymarket UI (portfolio → resolved positions → Claim).

---

## Troubleshooting: “No redeemable positions” but I have claimable positions

- **Not an Alchemy issue.** Discovery uses the Polymarket Data API (REST), not Alchemy. Alchemy is only used when sending the redeem transaction.

- **Fallback in script:** The script now tries two ways to find redeemable positions: (1) API with `redeemable=true`, then (2) fetch all positions for your address and filter for `redeemable` in code. Redeploy and run again; you may see “Found N redeemable position(s) via fallback.”

- **Proxy wallet (e.g. PolyGun):** If you trade via PolyGun or another app, your positions may be under a **proxy wallet** address, not your main wallet. Add `POLYMARKET_PROXY_WALLET=0xYourProxyAddress` to `.env`. Find the proxy in your app (e.g. profile, settings, or “wallet” / “proxy” in the UI). The script will look up positions for both your main address and the proxy. **Redeeming** still requires the private key for whichever wallet actually holds the tokens (that wallet signs the redeem tx).
