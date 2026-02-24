# Check if the bots are running and view errors

## Droplet IPs and services

| Droplet | IP | Services (systemd unit) |
|--------|-----|-------------------------|
| D1 (B1/B2/B3) | 188.166.15.165 | `cursorbot` |
| D2 (B4 + B1c/B2c/B3c) | 161.35.149.219 | `cursorbot-b4-5m`, `cursorbot-b123c` + **Polymarket outcome resolver** (cron every 10 min) |
| D3 (B5) | 164.92.210.132 | `cursorbot-b5` |

**Deploy resolver changes:** The script `resolve-polymarket-outcomes` runs on **D2** only. After pushing code changes, on D2 run: `cd /root/cursorbot && git pull origin main && npm run build`. No restart needed; cron picks up the new build.

**Resolver and B4 CLOB:** The resolver must verify each B4 order was filled (via CLOB `getOrder`) before setting Win/Loss. On D2, when the resolver ran from cron **without** the proxy applied, the B4 CLOB client (derive mode) failed ("Maximum number of redirects exceeded" / "derive did not return key/secret/passphrase"), so the resolver had no client and was setting Win/Loss from Gamma market resolution only — phantom Wins. Fix: the resolver now (1) applies `HTTPS_PROXY`/`HTTP_PROXY` at script start so derive and `getOrder` use the proxy (same as the B4 runner), (2) uses derive only for B4 (same as the runner; static keys are not used for placement), (3) requires a working B4 CLOB client for B4 (and B1/B2/B3 Poly); if missing, sets outcome to `no_fill` instead of resolving from Gamma. Ensure the resolver cron runs from the repo so `.env` is loaded, e.g. `*/10 * * * * cd /root/cursorbot && node dist/scripts/resolve-polymarket-outcomes.js >> /root/cursorbot/logs/resolve-outcomes.log 2>&1`.

**B4 placement (D2):** The B4 spread-runner **does** place limit orders when spread exceeds tier thresholds; journal logs show `[B4] PLACED` with orderIds. Some attempts fail with `not enough balance / allowance` (e.g. when T1 and T2 fire in the same window and balance is tied up). So B4 is placing; the issue was the resolver marking Win without checking fill. After deploying the resolver fix and rebuilding on D2, run `cd /root/cursorbot && git pull && npm run build` so the next cron run uses the new script.

**B1c/B2c/B3c (D2):** B123c uses **derive-only** Polymarket CLOB (same as B4 and D1 runner); static API keys are not used. After code changes: on D2 run `cd /root/cursorbot && git pull origin main && npm run build && systemctl restart cursorbot-b123c`. To verify placement on the **B123c wallet**: `node dist/scripts/place-b123c-test-order.js` — the script loads `.env` then `.env.b123c` (override), same as the cursorbot-b123c service, so the order appears in the B123c wallet.

D2 uses password auth by default; add your SSH key with `ssh-copy-id root@161.35.149.219` for key-based checks.

## Security updates (and rollback)

- **Apply updates (no reboot):** `ssh root@<IP>` then `DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get upgrade -y -qq`. Bots keep running; no firewall or proxy changes.
- **Rollback:** Full rollback of `apt upgrade` is not supported. If something breaks, fix forward (restart the affected service, or restore that droplet from a DigitalOcean snapshot if you took one before upgrading). Taking a snapshot before running upgrades is recommended if you want a safe rollback path.

## Backup droplet files to your Mac (offline copy)

From your Mac, pull the app directory and service files from each droplet. App path on droplets is `/root/cursorbot`; adjust if you use a different path.

```bash
# Create a folder for backups (e.g. in your home dir)
mkdir -p ~/cursorbot-droplet-backups
cd ~/cursorbot-droplet-backups

# D1 — full app dir + systemd units for cursorbot
rsync -avz --progress root@188.166.15.165:/root/cursorbot/ ./D1-cursorbot/
rsync -avz root@188.166.15.165:/etc/systemd/system/cursorbot.service ./D1-cursorbot/

# D2 — full app dir (B4 and B123c share it) + both service files
rsync -avz --progress root@161.35.149.219:/root/cursorbot/ ./D2-cursorbot/
rsync -avz root@161.35.149.219:/etc/systemd/system/cursorbot-b4-5m.service ./D2-cursorbot/
rsync -avz root@161.35.149.219:/etc/systemd/system/cursorbot-b123c.service ./D2-cursorbot/
```

This includes `.env` (and `.env.b123c` if present). **Keep backups secure** — they contain secrets. To skip `node_modules` (faster, smaller; you can re-run `npm ci` from repo if needed): add `--exclude=node_modules` to the `rsync` for `/root/cursorbot/`.

## Snapshots (DigitalOcean)

- **Live snapshot** is fine for D1, D2, and D3. All bots use interval-based timers; at worst one cycle may run a few seconds late during the snapshot. No need to stop the droplet or the services.
- **You do not need to hit Emergency OFF or Pause B4** before taking the snapshot. Those buttons only set flags in Supabase (no new orders); they don’t change what’s on the droplet disk. The snapshot captures app code and `.env` on the droplet; pause state lives in the DB. So: take the snapshot with bots running, or pause if you prefer — but pausing won’t make the snapshot “more consistent,” and you’d need to Resume after.

## Is the service running?

**On the droplet:**

```bash
ssh root@188.166.15.165
sudo systemctl status cursorbot
```

You should see `Active: active (running)`. If you see `active (auto-restart)` or `failed`, the process is exiting (check errors below).

## View logs (stdout + errors)

**Live log stream:**

```bash
ssh root@188.166.15.165
sudo journalctl -u cursorbot -f
```

You’ll see “Cursorbot starting…” and then either nothing (idle until a window opens) or lines like “B1 Kalshi BTC 96% limit orderId=…”. Exit with `Ctrl+C`.

**Last 100 lines:**

```bash
sudo journalctl -u cursorbot -n 100
```

## Check if Polymarket is working

1. **Heartbeat** – Every ~60s the log should show `[cursorbot] alive | ... | Kalshi + Polymarket` (not "Kalshi only") when `ENABLE_POLYMARKET=true` in `.env`. If it says "Kalshi only", Poly is off or env is wrong.
2. **When a B1/B2/B3 window hits** – Look for lines like `B1 Poly BTC orderId=…` or `B2 Poly ETH orderId=…`. If you only see `B1 Kalshi …` and never `B1 Poly …`, either spread/size didn’t qualify for Poly or Poly failed (check step 3).
3. **Dashboard** – **Recent positions** should sometimes show **exchange: polymarket**. **Recent errors** will show Poly-related failures (e.g. CLOB auth, proxy, or “missing env”).
4. **Poly env** – On the droplet, for **derive mode** (recommended): `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_FUNDER`, `POLYMARKET_DERIVE_KEY=true`, `ENABLE_POLYMARKET=true`. For static keys use the three `POLYMARKET_API_*` vars instead of `DERIVE_KEY`. Restart after any change: `systemctl restart cursorbot`.
5. **Trading enabled** – In the **dashboard**, ensure **Emergency** is **Resume** (not OFF). Set **position sizes** > 0 for Kalshi and Polymarket so the bots place orders; 0 size is skipped.
6. **B1/B2/B3 Polymarket size** – Polymarket has a **$5 min notional** (our floor). At 97¢, that means min 6 contracts. If the dashboard Poly size yields less, the bot bumps it. **Increasing the Poly size on the dashboard increases orders** (e.g. 10 → 10, 20 → 20). **Kalshi has no $5 floor**; Kalshi size is used as-is from the dashboard.

## Errors in the dashboard

Errors are written to Supabase **error_log** and shown in the **dashboard** under “Recent errors”.

### Common error types

- **Kalshi POST 400** – Order rejected (market closed, invalid price/size, balance). Check full message in dashboard.
- **bot_config: fetch failed** – Supabase network issue. Usually transient.
- **market_data fetch failed** – Binance/Kalshi unreachable (often geo-block).
- **Polymarket order rejected / no orderId** – See “Debugging Polymarket” below.

**One-time setup in Supabase:** In SQL Editor, run:

```sql
create table if not exists error_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  message text not null,
  context jsonb,
  stack text
);
create index if not exists error_log_created_at on error_log (created_at desc);
```

Allow the anon key to `SELECT` from `error_log` (same as for `positions`) so the dashboard can read them.

## Debugging Polymarket placement

When Polymarket skips show “no orderId or error” but no Poly error appears in Recent errors:

1. **Check bot stdout** – The bot logs `[Poly] placing order...` and `[Poly] order rejected` or `[Poly] CLOB HTTP error` on failure. On the droplet: `journalctl -u cursorbot -f`.
2. **Run the test script** – From the repo with `.env` and proxy set:
   ```bash
   npx tsx src/scripts/place-test-order-polymarket.ts
   ```
   This places a single test order and prints the full request params and raw API response. Use it to reproduce the failure locally.
3. **Polymarket skips** – The skip reason now includes up to 400 chars of the actual error when available. Check the “Polymarket skips” table in the dashboard for the real API message.

## B4 / B5 trades not showing on dashboard

If **B4 trades** or **B5 trades** (or "placed but not filled") don't update while other bots (B1/B2/B3, B1c/B2c/B3c) do:

1. **Same Supabase project** – The dashboard uses `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. B4 runs on D2 and B5 on D3; each uses `SUPABASE_URL` and `SUPABASE_ANON_KEY` from that droplet's `.env`. If D2 or D3 point at a different project (or wrong URL/key), B4/B5 positions are written elsewhere and won't appear. On D2: `grep SUPABASE_URL /root/cursorbot/.env` and compare to the dashboard's env (e.g. Vercel → Settings → Environment Variables). They must match.
2. **Position log failures** – After a place, the bot logs the position to Supabase. If that insert fails, you'll see `[B4] position log failed (dashboard will not show this trade): …` or `[B5] position log failed …` in the service logs. On D2: `journalctl -u cursorbot-b4-5m -n 500 | grep -i "position log failed"`. On D3: same for `cursorbot-b5-spread` (or the B5 unit name). Fix Supabase credentials or RLS so the anon key can `INSERT` into `positions`.
3. **Resolver (B4/B5 outcome)** – The **Polymarket outcome resolver** runs on **D2 only** (cron every 10 min). It reads unresolved B4/B5 positions from Supabase, checks fill via CLOB and market result via Gamma, then updates `outcome` and `resolved_at`. So B4/B5 rows appear as "Pending" until the resolver runs (and the market has closed). Resolver cron: `crontab -l` on D2 should show something like `*/10 * * * * cd /root/cursorbot && node dist/scripts/resolve-polymarket-outcomes.js …`. Run it once by hand: `cd /root/cursorbot && node dist/scripts/resolve-polymarket-outcomes.js` and check for errors. Resolver needs the same proxy as B4 (HTTPS_PROXY/HTTP_PROXY in `.env`) so CLOB getOrder works.

## Kalshi only (no Polymarket)

On the droplet, in `/root/cursorbot/.env`:

- **Omit** `ENABLE_POLYMARKET`, or set `ENABLE_POLYMARKET=false`.

Then restart:

```bash
sudo systemctl restart cursorbot
```

The bots will only place orders on Kalshi.

## Current Kalshi spreads (script)

**Important:** `ssh` starts a *new* shell on the droplet. If SSH fails (e.g. "Permission denied"), the next commands you type run on **your Mac**, not the droplet. So you’d be doing `cd /root/cursorbot` on your Mac (which has no `/root`), and `npx tsx src/scripts/...` would look for the file in your Mac home directory and fail.

### Option A – Run on the droplet (Binance works there)

1. **Get a shell on the droplet** (one command; wait until you see the droplet prompt, e.g. `root@cursorbot:~#`):
   ```bash
   ssh root@188.166.15.165
   ```
   If you get "Permission denied (publickey)", set up SSH access first (add your Mac’s public key to the droplet, or use password auth if enabled).

2. **Then**, on the droplet, go to the repo and run the script (the path may be different on your droplet; common: `/root/cursorbot` or `~/cursorbot`):
   ```bash
   cd /root/cursorbot
   npx tsx src/scripts/current-kalshi-spreads.ts
   ```

### Option B – Run on your Mac (from project folder)

Only the project directory has `src/scripts/`. Run from your **project root** (e.g. CURSORBOT):

```bash
cd /Users/jodan/Documents/CURSORBOT
npx tsx src/scripts/current-kalshi-spreads.ts
```

Binance may return 451 (geo-block) from some regions; if so, use Option A on the droplet.

## No proxy (e.g. Amsterdam)

If the droplet is in a non‑restricted region (e.g. Amsterdam), you can remove the proxy so Polymarket CLOB is called directly:

1. Edit `/root/cursorbot/.env` and **remove or comment out** the `HTTP_PROXY` and `HTTPS_PROXY` lines.
2. Restart: `sudo systemctl restart cursorbot`.

**Note:** The CLOB client uses **axios** (not fetch). The bot now sets `axios.defaults.httpsAgent` to a proxy agent when proxy env vars are set, so both getTickSize and order placement go through the proxy. Previously only undici (fetch) was proxied, so CLOB requests never used the proxy and could hit redirect/geo errors.

## Pause B5 and assess what happened

B5 has **no dashboard pause** (unlike B4 or Emergency OFF). To pause B5 you stop the service on D3.

**Pause B5 (stop placing orders):**

```bash
ssh root@164.92.210.132
sudo systemctl stop cursorbot-b5
```

**Assess what happened:**

1. **Recent logs (last 500 lines):**
   ```bash
   ssh root@164.92.210.132
   sudo journalctl -u cursorbot-b5 -n 500 --no-pager
   ```

2. **Search for trades and limit sells** (change the date if needed):
   ```bash
   sudo journalctl -u cursorbot-b5 --since "2026-02-18" --no-pager | grep -E 'BOUGHT|Limit sell|Limit sell failed|Sell monitor|Sold:'
   ```
   - **BOUGHT** — FOK buy filled (price, ~shares).
   - **Limit sell placed** — GTC limit sell posted (price, size, orderId).
   - **Limit sell failed** — CLOB rejected the sell (error message).
   - **Sell monitor** / **Sold:** — FOK sell of remainder when mid ≥ 1.6× buy.

3. **Check Polymarket** — Portfolio / order history for the B5 wallet to see open positions, filled orders, and resting limit orders.

4. **If you see only `[B5] scan error: Error: Binance 1m failed for BTCUSDT`** — D3 cannot reach Binance (often geo-block). Every scan fails before edge/candidates, so **no buys or limit sells** happen in that period. To fix: route Binance through a proxy that allows it, or run the edge step elsewhere and feed B5 (future change).

**Resume B5:**

```bash
ssh root@164.92.210.132
sudo systemctl start cursorbot-b5
sudo systemctl status cursorbot-b5 --no-pager
```

## Delay timers and blackout

- **B2 → B1:** After B2 places an order for an asset, B1 skips that asset for **15 minutes** (same asset only). Also: if during any B2 check the spread is **above 0.5%**, B1 is delayed **15 minutes** for that asset (even if B2 didn’t place).
- **B3 → B1/B2:** After B3 places for an asset, both B1 and B2 skip that asset for **1 hour** (via `asset_blocks` in Supabase).
- **Blackout:** No trades on any bot during **08:00–08:15 MST (Utah, Mountain time) Monday–Friday** (15:00–15:15 UTC). The log will show `[tick] blackout 08:00–08:15 MST (Utah) Mon–Fri; no trades` about once a minute during that window.
