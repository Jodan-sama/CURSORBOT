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

## Errors in the dashboard

Errors are written to Supabase **error_log** and shown in the **dashboard** under “Recent errors”.

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

## No proxy (e.g. Amsterdam)

If the droplet is in a non‑restricted region (e.g. Amsterdam), you can remove the proxy so Polymarket CLOB is called directly:

1. Edit `/root/cursorbot/.env` and **remove or comment out** the `HTTP_PROXY` and `HTTPS_PROXY` lines.
2. Restart: `sudo systemctl restart cursorbot`.
