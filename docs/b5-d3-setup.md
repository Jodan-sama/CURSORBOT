# B5 Basket Bot — D3 Setup Only

**Do not use this on D1 or D2.** B5 runs only on a separate droplet (D3). D1 and D2 are unchanged.

## D3 droplet

- **IP:** 164.92.210.132
- **B5 wallet (proxy):** `0x439BfEB801c12E63C8571Dffc04e74a8C3Dba6eb` — use this as `POLYMARKET_FUNDER` and (if your app holds positions in a proxy) `POLYMARKET_PROXY_WALLET` on D3.
- **Private key:** Never commit. Put only in `.env` on D3 as `POLYMARKET_PRIVATE_KEY`.

## 1. On D3: clone and build

```bash
ssh root@164.92.210.132
cd /root && git clone https://github.com/Jodan-sama/CURSORBOT.git cursorbot
cd cursorbot && npm install && npm run build
```

## 2. Create `.env` on D3

Create `/root/cursorbot/.env` with **only** B5 wallet and B5 config (no D1/D2 keys):

```env
POLYMARKET_PRIVATE_KEY=0x<your_b5_private_key_hex>
POLYMARKET_FUNDER=0x439BfEB801c12E63C8571Dffc04e74a8C3Dba6eb
POLYMARKET_PROXY_WALLET=0x439BfEB801c12E63C8571Dffc04e74a8C3Dba6eb
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
POLYMARKET_DERIVE_KEY=true

HTTPS_PROXY=http://your-proxy:port

B5_POSITION_SIZE_USD=5
B5_MAX_BASKET_COST=10
B5_MIN_EDGE=0.22
B5_CHEAP_THRESHOLD=0.08
B5_SCAN_INTERVAL_SECONDS=300
B5_DAILY_LOSS_LIMIT=-0.05
```

- **HTTPS_PROXY** — copy the same value from your D1 (or D2) droplet `.env`. Same proxy as B4/B123c; required for placing orders. Omit only if D3 is not geo-blocked.
- **POLYMARKET_DERIVE_KEY=true** so the bot derives CLOB API keys from the wallet (no need to paste API key/secret/passphrase).
- Fund the B5 wallet with USDC (e.g. $100 to start) and a small amount of POL for claim gas.

## 3. Install systemd service (B5 only)

```bash
sudo cp /root/cursorbot/deploy/cursorbot-b5.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cursorbot-b5
sudo systemctl status cursorbot-b5
```

Logs: `journalctl -u cursorbot-b5 -f`

## 4. Claim cron on D3 (every 5 minutes)

B5 wallet only; no overlap with D1/D2 claim times.

```bash
crontab -e
```

Add:

```
0,5,10,15,20,25,30,35,40,45,50,55 * * * * cd /root/cursorbot && DOTENV_CONFIG_PATH=.env /usr/bin/node dist/scripts/claim-polymarket.js >> /var/log/cursorbot-claim-b5.log 2>&1
```

## 5. Behaviour summary

- **Sizing:** Uses the **highest balance the wallet has ever seen** (persisted in `b5-state/max_balance.json` on D3) so that pending claims don’t shrink position size.
- **Per leg:** min $5, max min(cap, maxBalanceSeen × 1.5%).
- **Per basket:** max min(cap, maxBalanceSeen × 6%), up to 4 legs.
- **Orders:** All CLOB/order traffic goes through `HTTPS_PROXY` (same as other droplets).
- **Daily loss:** If daily PnL &lt; −5% of that day’s opening balance, scans skip placing new baskets until the next day.

D1 and D2 are not modified.

## 6. B5 + Supabase (optional): min edge and loss log

To control B5 min edge from the Vercel dashboard and log losing trades:

1. **Run the B5 tables once** in your Supabase project (same as the dashboard). In Supabase → SQL Editor, run the contents of `supabase/b5_tables.sql`. This creates `b5_config` (single row: min edge) and `b5_losses` (last 20 losses with edge at entry). No other tables are touched.

2. **On D3**, add to `.env` (same project URL/key as dashboard):
   ```env
   SUPABASE_URL=https://xxxxx.supabase.co
   SUPABASE_ANON_KEY=your_anon_key
   ```
   B5 will then read `min_edge` from `b5_config` each scan (overriding `B5_MIN_EDGE` in env) and append to `b5_losses` when the sell monitor closes a position at a loss.

3. **Vercel dashboard:** The B5 section lets you change the min edge (text box + Save) and shows the last 20 losses with their edge at entry.
