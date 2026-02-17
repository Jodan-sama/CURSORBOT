# Recreate Supabase Project (Complete Setup)

Use this guide if you deleted your Supabase project and need to set it up again from scratch.

---

## Step 1: Create a new Supabase project

1. Go to [supabase.com](https://supabase.com) and sign in.
2. Click **New Project**.
3. Choose your organization.
4. Set **Name** (e.g. `cursorbot`), **Database Password** (save it), **Region**.
5. Click **Create new project** and wait for it to finish.

---

## Step 2: Run the schema

1. In your Supabase project, open **SQL Editor**.
2. Click **New query**.
3. Copy the **entire** contents of `supabase/schema.sql` from this repo.
4. Paste into the query editor.
5. Click **Run**.

This creates all tables and seeds:
- `bot_config` (default row with emergency_off = false)
- `bot_position_sizes`
- `positions`
- `asset_blocks`
- `error_log`
- `b4_paper_log`
- `polymarket_claim_log`
- `poly_skip_log`
- `spread_thresholds` (B1/B2/B3 × BTC/ETH/SOL/XRP)

---

## Step 3: RLS policies (if RLS is enabled)

If **Row Level Security** is on for any table, add policies so the anon key can do what the bot and dashboard need:

| Table | Operations | Policy |
|-------|------------|--------|
| `bot_config` | SELECT, UPDATE | Allow anon to SELECT and UPDATE where `id = 'default'` |
| `positions` | SELECT, INSERT | Allow anon to SELECT all, INSERT |
| `bot_position_sizes` | SELECT, INSERT, UPDATE | Allow anon (for upsert) |
| `asset_blocks` | SELECT, INSERT, UPDATE | Allow anon (for upsert) |
| `spread_thresholds` | SELECT, INSERT, UPDATE | Allow anon (for upsert) |
| `error_log` | SELECT, INSERT | Allow anon |
| `b4_paper_log` | SELECT, INSERT | Allow anon |
| `polymarket_claim_log` | SELECT, INSERT | Allow anon |
| `poly_skip_log` | SELECT, INSERT | Allow anon |

**Simpler option:** For a private project, you can leave RLS **off** on these tables. The anon key is public but only allows what your app uses.

---

## Step 4: Get your API credentials

1. In Supabase, go to **Settings** → **API**.
2. Copy:
   - **Project URL** (e.g. `https://xxxxx.supabase.co`)
   - **anon public** key (under "Project API keys")

---

## Step 5: Update your `.env` files

**On the droplet** (`/root/cursorbot/.env`):

```
SUPABASE_URL=https://YOUR_NEW_PROJECT.supabase.co
SUPABASE_ANON_KEY=your_new_anon_key
```

**Locally** (for scripts like claim-polymarket, emergency-off):

Same values in your project root `.env`.

---

## Step 6: Update Vercel (dashboard)

1. Go to [vercel.com](https://vercel.com) → your Cursorbot project.
2. **Settings** → **Environment Variables**.
3. Update:
   - `NEXT_PUBLIC_SUPABASE_URL` = your new Project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = your new anon key
4. **Redeploy** the dashboard (Deployments → ⋮ → Redeploy).

---

## Step 7: Restart the bot on the droplet

```bash
ssh root@YOUR_DROPLET_IP
cd /root/cursorbot
nano .env   # Update SUPABASE_URL and SUPABASE_ANON_KEY
sudo systemctl restart cursorbot
sudo systemctl status cursorbot
```

---

## Step 8: Verify

1. **Dashboard:** Open your Vercel URL. You should see the dashboard with "Running" status. Toggle Emergency OFF/ON to confirm it works.
2. **Bot:** Check logs: `sudo journalctl -u cursorbot -f`. The bot should run without Supabase errors.
3. **Claim script:** Next cron run at :06, :21, :36, or :51 should write to `polymarket_claim_log`.

---

## Tables reference (what the schema creates)

| Table | Purpose |
|-------|---------|
| `bot_config` | Emergency off, position sizes, B3 block min, B2 spread threshold |
| `bot_position_sizes` | Per-bot/asset size overrides |
| `positions` | Log of every order (Kalshi + Polymarket) |
| `asset_blocks` | B3 block state (blocks B1/B2 for 1h after B3 places) |
| `error_log` | Bot errors for dashboard |
| `b4_paper_log` | B4 paper trader log |
| `polymarket_claim_log` | Claim script status (ALL ITEMS CLAIMED, etc.) |
| `poly_skip_log` | Why Polymarket orders were skipped |
| `spread_thresholds` | Entry thresholds per bot/asset |

---

## Optional: Restore old data

If you had a backup of your old Supabase data, you could restore `positions` and `error_log` for history. The bot and dashboard will work without it—they'll just start with empty tables.
