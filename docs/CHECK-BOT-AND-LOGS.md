# Check if the bots are running and view errors

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
6. **B2/B3 Polymarket size** – Polymarket CLOB requires min **$1 notional**. At 97¢, that means min 2 contracts. If you set B2/B3 Poly to 1, the bot uses 2 and logs `size 1 → 2 (min $1 notional)`.

## Errors in the dashboard

Errors are written to Supabase **error_log** and shown in the **dashboard** under “Recent errors”.

### Common error types

- **Kalshi POST 400** – Order rejected (market closed, invalid price/size, balance). Check full message in dashboard.
- **bot_config: fetch failed** – Supabase network issue. Usually transient.
- **market_data fetch failed** – Binance/Kalshi unreachable (often geo-block).

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

## Delay timers and blackout

- **B2 → B1:** After B2 places an order for an asset, B1 skips that asset for **15 minutes** (same asset only). Also: if during any B2 check the spread is **above 0.5%**, B1 is delayed **15 minutes** for that asset (even if B2 didn’t place).
- **B3 → B1/B2:** After B3 places for an asset, both B1 and B2 skip that asset for **1 hour** (via `asset_blocks` in Supabase).
- **Blackout:** No trades on any bot during **08:00–08:15 MST (Utah, Mountain time) Monday–Friday** (15:00–15:15 UTC). The log will show `[tick] blackout 08:00–08:15 MST (Utah) Mon–Fri; no trades` about once a minute during that window.
