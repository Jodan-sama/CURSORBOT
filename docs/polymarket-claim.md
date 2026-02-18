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
| `POLYMARKET_SAFE_ADDRESS` | **(PolyGun)** Polymarket Wallet (Safe) address that holds positions. When set, script redeems via Safe and sends USDC to `POLYGON_WALLET`. | `POLYMARKET_SAFE_ADDRESS=0xBDD5AD35435bAb6b3AdF6A8E7e639D0393263932` |
| `POLYGON_WALLET` | **(PolyGun only)** Where claimed USDC from the **PolyGun Safe** is sent. **Polymarket proxy** claims stay in the Safe (ready to trade on Polymarket). Default `0x6370422C2DA0cb4b0fE095DDC1dc97d87Cd5223b`. | `POLYGON_WALLET=0x6370422C2DA0cb4b0fE095DDC1dc97d87Cd5223b` |
| `POLYMARKET_PROXY_WALLET` | **(Optional)** If positions don’t show up, your app (e.g. PolyGun) may hold them in a **proxy wallet**. Set this to that proxy **address** (0x + 40 hex chars, like 0x1234…abcd). Do **not** put a condition ID or private key here (those are 64 hex chars). The script looks up positions for it. You still need the **private key for the wallet that holds the tokens** (proxy or EOA) to redeem. | `POLYMARKET_PROXY_WALLET=0x...` |

**Example block to paste (then replace the values):**

```env
POLYMARKET_PRIVATE_KEY=0xYourPrivateKeyHexNoSpaces
POLYMARKET_FUNDER=0xYourWalletAddress
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YourAlchemyApiKey
```

**PolyGun (Safe) — claim into your Polygon wallet:** Set `POLYMARKET_SAFE_ADDRESS` to your Polymarket Wallet (e.g. `0xBDD5AD35435bAb6b3AdF6A8E7e639D0393263932`) and `POLYGON_WALLET` to where USDC should go (e.g. `0x6370422C2DA0cb4b0fE095DDC1dc97d87Cd5223b`). Use the **private key of an owner** of that Safe for `POLYMARKET_PRIVATE_KEY`. The script will redeem via the Safe and transfer claimed USDC to `POLYGON_WALLET`.

**Polymarket proxy vs PolyGun:** Positions in your **Polymarket proxy** (e.g. `0xbafbed80...` from polymarket.com) stay in that Safe after redeem – USDC remains available to trade. Positions in the **PolyGun Safe** (e.g. `0xbdd5ad...`) are transferred to `POLYGON_WALLET` after redeem.

**Two wallets (EOA + Safe):** The script discovers and claims from **both** your main Polymarket proxy and the PolyGun Safe. Set both:
- `POLYMARKET_FUNDER=0xbafbed80...` and `POLYMARKET_PRIVATE_KEY=...` for the EOA
- `POLYGUN_CLAIM_FUNDER=0xbdd5ad...` and `POLYGUN_CLAIM_PRIVATE_KEY=...` for the Safe

**Two wallets in one .env:** If you have both a main Polymarket wallet (for the bot) and a PolyGun wallet (for claiming), use the **PolyGun-only** names for the Safe; the script checks these and also uses POLYMARKET_* for the EOA:

| Use for claim script only | Same as |
|---------------------------|---------|
| `POLYGUN_CLAIM_PRIVATE_KEY` | `POLYMARKET_PRIVATE_KEY` |
| `POLYGUN_CLAIM_FUNDER` | `POLYMARKET_FUNDER` |
| `POLYGUN_CLAIM_SAFE_ADDRESS` | `POLYMARKET_SAFE_ADDRESS` |

Put your **Polymarket** block first (for the main bot) and your **PolyGun** block second using these `POLYGUN_CLAIM_*` names; the claim script will use the PolyGun set and the main bot will use the Polymarket set.

- **POL (MATIC) for gas:** The wallet that **signs** the redeem tx (the one whose private key is in `POLYMARKET_PRIVATE_KEY`) must have **POL on Polygon** to pay gas. If you see `insufficient funds for intrinsic transaction cost` / `balance 0`, that wallet has no POL. Send **0.1–0.5 POL** (or a few dollars’ worth) to that wallet’s address on the **Polygon** network. Each redeem costs only a few cents of gas.
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
6,21,36,51 * * * * cd /root/cursorbot && /usr/bin/node dist/scripts/claim-polymarket.js
```

Save (`Ctrl+O`, `Enter`) and exit (`Ctrl+X`).  
Cron will run the script at **:06, :21, :36, :51** every hour (6 minutes into each 15-minute window).

**Deploy updates:** After pulling or copying new code, run `npm run build` on the droplet so `claim-polymarket.js` and `check-safe-balance.js` are compiled.

**Optional:** To log each run (date, time, status only), use:

```
6,21,36,51 * * * * cd /root/cursorbot && mkdir -p logs && /usr/bin/node dist/scripts/claim-polymarket.js >> logs/claim-polymarket.log 2>&1
```

The script also writes a **one-line summary** (date, time, message) to `logs/claim-polymarket.log` and to Supabase `polymarket_claim_log`. The dashboard shows the latest status: **ALL ITEMS CLAIMED**, **NEED MORE POL**, or **CLAIM INCOMPLETE**.

**D1 vs D2:** **D1** is the B1/B2/B3 (Kalshi/Poly) droplet — the cron above (6,21,36,51) is for D1 if you run claim there. **Do not** run B4 claim on D1. **D2** is the B4 + B1c/B2c/B3c droplet — see **D2 only** below for B4 every 3 min and B123c at :06/:21/:36/:51.

### 6b. D2 only: B4 wallet every 3 min, B123c wallet at :06/:21/:36/:51

On **D2** (B4 + B1c/B2c/B3c droplet) you want:

- **B4 wallet** claimed **every 3 minutes** (only B4).
- **B1c/B2c/B3c wallet** claimed at **:06, :21, :36, :51** (only that wallet).

The claim script uses whatever `.env` is loaded: it discovers and claims only for the wallet(s) defined in that env. So use two cron lines and two env files:

1. **`.env`** on D2 should contain **only** the B4 wallet (POLYMARKET_FUNDER, POLYMARKET_PRIVATE_KEY, POLYGON_RPC_URL, etc. for B4). No B123c/POLYGUN_CLAIM_* in `.env`.
2. **`.env.b123c`** on D2 contains **only** the B1c/B2c/B3c wallet (same var names, but values for the B123c wallet).

Then in crontab on D2:

```cron
# B4 wallet only — every 3 minutes (uses .env)
0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57 * * * * cd /root/cursorbot && DOTENV_CONFIG_PATH=.env /usr/bin/node dist/scripts/claim-polymarket.js >> /var/log/cursorbot-claim-b4.log 2>&1

# B123c wallet only — at :06, :21, :36, :51 (uses .env.b123c)
6,21,36,51 * * * * cd /root/cursorbot && DOTENV_CONFIG_PATH=.env.b123c /usr/bin/node dist/scripts/claim-polymarket.js >> /var/log/cursorbot-claim-b123c.log 2>&1
```

Node’s `dotenv` (used by the script) respects `DOTENV_CONFIG_PATH`: each run loads only that file, so B4 and B123c are claimed separately.

### 7. Test once by hand

```bash
cd /root/cursorbot && node dist/scripts/claim-polymarket.js
```

You should see either “Discovering redeemable positions…” and then “Redeemed: …” for each, or “No condition IDs to redeem…” if there’s nothing to claim yet.

At the end you'll see **ALL ITEMS CLAIMED**, **NEED MORE POL**, or **CLAIM INCOMPLETE**.

### 8. Check Safe USDC balance

```bash
cd /root/cursorbot && npm run check-safe-balance
```

Prints the Safe's USDC balance in human form (e.g. `0.265537`).

### 9. Transfer USDC out of PolyGun Safe

If USDC is stuck in the PolyGun Safe (e.g. after claiming, or leftover balance), transfer it to `POLYGON_WALLET`:

```bash
cd /root/cursorbot && npm run transfer-safe-usdc
```

Requires `POLYGUN_CLAIM_FUNDER` (or `POLYMARKET_SAFE_ADDRESS`) = the Safe address, `POLYGON_WALLET` = where to send, and `POLYGUN_CLAIM_PRIVATE_KEY` (or `POLYMARKET_PRIVATE_KEY`) = signer/owner. Set `POLYGON_WALLET` to your desired destination (e.g. your MetaMask or Polymarket proxy) before running.

---

## In-repo claim script (auto-discovery)

The script uses `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_FUNDER`, and `POLYGON_RPC_URL` from `.env`. With no arguments and no `CONDITION_IDS`, it **automatically discovers redeemable positions** for that wallet via the Polymarket Data API and redeems each one.

**Optional:** To redeem only specific markets, set `CONDITION_IDS=id1,id2` in `.env` or pass condition IDs as arguments. **Manual:** Claim from the Polymarket UI (portfolio → resolved positions → Claim).

---

## Troubleshooting: “No redeemable positions” but I have claimable positions

- **Not an Alchemy issue.** Discovery uses the Polymarket Data API (REST), not Alchemy. Alchemy is only used when sending the redeem transaction.

- **Fallback in script:** The script now tries two ways to find redeemable positions: (1) API with `redeemable=true`, then (2) fetch all positions for your address and filter for `redeemable` in code. Redeploy and run again; you may see “Found N redeemable position(s) via fallback.”

- **Proxy wallet (e.g. PolyGun):** If you trade via PolyGun or another app, your positions may be under a **proxy wallet** address, not your main wallet. Add `POLYMARKET_PROXY_WALLET=0xYourProxyAddress` to `.env`. Find the proxy in your app (e.g. profile, settings, or “wallet” / “proxy” in the UI). The script will look up positions for both your main address and the proxy. **Redeeming** still requires the private key for whichever wallet actually holds the tokens (that wallet signs the redeem tx).

- **"insufficient funds for intrinsic transaction cost" / "balance 0":** The wallet that signs (the one whose key is in `POLYMARKET_PRIVATE_KEY`) has **no POL (MATIC)** on Polygon. Send **0.1–0.5 POL** to that wallet’s address on **Polygon**; then run the script again.

- **"insufficient funds for gas * price + value" (ran out mid-run):** The signer ran out of POL partway through. Each redeem uses ~0.006–0.01 POL; 15 redeems + transfer needs ~0.15–0.2 POL. Top up the signer with **0.2–0.5 POL** and run `claim-poly` again.

- **Tx succeeds but 0 USDC / positions still in PolyGun:** The script calls `redeemPositions` from the **EOA** in `POLYMARKET_PRIVATE_KEY` (e.g. 0xd61800...). The CTF burns tokens from **msg.sender** and credits USDC to msg.sender. Your PolyGun **Polymarket Wallet** (0xbdd5ad...) is a **Gnosis Safe (smart contract)** — the positions are held by that Safe, not your EOA. So redeeming from your EOA burns 0 tokens and returns 0 USDC. A successful PolyGun claim uses **Safe.execTransaction** so the Safe calls the CTF; tokens are burned from the Safe and USDC goes to the Safe. To claim from this script you need either: (1) positions in an EOA you control and use that key here, or (2) Safe support (build/sign a Safe tx that tells the Safe to call `redeemPositions`; you must be an owner of that Safe). Until then, use **PolyGun's Claim** for positions in the Polymarket Wallet.
