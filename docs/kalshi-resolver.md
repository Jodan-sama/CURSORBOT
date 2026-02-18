# Kalshi outcome resolver (B1/B2/B3)

Resolves win/loss for **Kalshi-only** B1/B2/B3 positions. Unfilled limit orders get `outcome = 'no_fill'` (still shown in dashboard; not counted in win rate). Filled orders get win/loss from Kalshi settlements.

## Where it runs

- **D1** (same box as the B1/B2/B3 bot). Needs `KALSHI_KEY_ID`, `KALSHI_PRIVATE_KEY`, and `SUPABASE_URL` / `SUPABASE_ANON_KEY` in `.env`.

## Cron (every 15 min at :03, :18, :33, :48)

Run at 3 minutes after each 15‑minute window (calm period).

On D1:

```bash
crontab -e
```

Add:

```cron
3,18,33,48 * * * * cd /root/cursorbot && /usr/bin/npx tsx src/scripts/resolve-kalshi-outcomes.ts >> /var/log/cursorbot-kalshi-resolver.log 2>&1
```

Adjust paths if your app lives elsewhere (`/root/cursorbot`, `tsx` path).

## Rollback

To stop resolving and leave D1 as before:

1. `crontab -e` and remove the line above (or comment it out).
2. No code changes are required on the bot itself; the resolver is a separate script. Existing `outcome` / `resolved_at` in the DB stay as-is; the dashboard will keep showing them.
