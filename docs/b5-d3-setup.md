# B5 Spread Bot — D3 Setup

**Do not use this on D1 or D2.** B5 spread runs only on D3. D1 and D2 are unchanged.

## D3 droplet

- **IP:** 164.92.210.132
- **B5 wallet:** `0x439BfEB801c12E63C8571Dffc04e74a8C3Dba6eb` — use as `POLYMARKET_FUNDER` (and `POLYMARKET_PROXY_WALLET` if needed) on D3.
- **Private key:** Put only in `.env` on D3 as `POLYMARKET_PRIVATE_KEY`.

## 1. On D3: clone and build

```bash
ssh root@164.92.210.132
cd /root/cursorbot   # or clone if fresh: git clone ... && cd cursorbot
git pull && npm install && npm run build
```

## 2. `.env` on D3

Create or update `/root/cursorbot/.env` with B5 wallet and config:

```env
POLYMARKET_PRIVATE_KEY=0x<your_b5_private_key_hex>
POLYMARKET_FUNDER=0x439BfEB801c12E63C8571Dffc04e74a8C3Dba6eb
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
POLYMARKET_DERIVE_KEY=true

HTTPS_PROXY=http://your-proxy:port

SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=your_anon_key
```

- **HTTPS_PROXY** — same as D1/D2; required for CLOB/RTDS. Use existing D3 proxy (no new proxy).
- **SUPABASE_*** — same project as dashboard so B5 spread runner can read/write `b5_state`, `b5_tier_blocks`, `b5_early_guard`.

## 3. B5 spread service (not the old B5 basket)

D3 runs **B5 spread** only (5-minute ETH/SOL/XRP Polymarket). Stop and disable the old B5 basket service if it was running:

```bash
sudo systemctl stop cursorbot-b5
sudo systemctl disable cursorbot-b5
```

Install and enable the B5 **spread** service:

```bash
sudo cp /root/cursorbot/deploy/cursorbot-b5-spread.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cursorbot-b5-spread
sudo systemctl status cursorbot-b5-spread
```

Logs: `journalctl -u cursorbot-b5-spread -f`

## 4. Claim cron on D3 (every 5 minutes)

B5 wallet only; no overlap with D1/D2 claim times.

```bash
crontab -e
```

Add or keep:

```
0,5,10,15,20,25,30,35,40,45,50,55 * * * * cd /root/cursorbot && DOTENV_CONFIG_PATH=.env /usr/bin/node dist/scripts/claim-polymarket.js >> /var/log/cursorbot-claim-b5.log 2>&1
```

## 5. Resolver on D2: `.env.b5` (B5 wallet for getOrder)

B5 **positions are resolved on D2** by the same Polymarket resolver script. The resolver needs the **B5 wallet** credentials on D2 so it can call `getOrder(order_id)` for B5 orders (fill check) and then set win/loss from Gamma.

On **D2**, create `/root/cursorbot/.env.b5` with the **same** B5 wallet as D3 (no placement from D2; read-only for resolution):

```env
POLYMARKET_PRIVATE_KEY=0x<same_b5_private_key_hex_as_D3>
POLYMARKET_FUNDER=0x439BfEB801c12E63C8571Dffc04e74a8C3Dba6eb
```

The resolver loads this when resolving `bot = 'B5'` positions and uses it only for CLOB `getOrder`; it does not place orders. D2’s main `.env` stays for B4/B1/B2/B3; `.env.b5` is used only for B5 resolution.

## 6. Behaviour summary (B5 spread)

- **Assets:** ETH, SOL, XRP — 5-minute Polymarket up/down markets only.
- **Strategy:** Same as B4 (tier spreads, T2→T1 block 5 min, T3→T1+T2 block 15 min, early guard, T3 window [100s, 180s)). Per-asset tier spreads and one position size; config and state from dashboard (Supabase).
- **Orders:** CLOB and RTDS (Chainlink) use D3’s `HTTPS_PROXY`.
- **Claim:** Every 5 minutes on D3 via cron; resolver runs on D2 and updates `positions.outcome` for B5 using `.env.b5`.

D1 and D2 code and services are unchanged except: D2 resolver includes B5 and reads `.env.b5` for B5 orders.
