# Dashboard on Vercel (step-by-step)

## What you need

1. **Repo on GitHub** — same as for the droplet (e.g. `YOUR_USERNAME/CURSORBOT`).
2. **Supabase URL and anon key** — from your Supabase project (Settings → API: Project URL and anon public).
3. **Vercel account** — sign up at [vercel.com](https://vercel.com) (GitHub login is easiest).

---

## 1. Push the repo to GitHub (if not done)

From your Mac, in the project folder:

```bash
cd /Users/jodan/Documents/CURSORBOT
git init
git add .
git commit -m "Initial cursorbot + dashboard"
git remote add origin https://github.com/YOUR_USERNAME/CURSORBOT.git
git branch -M main
git push -u origin main
```

Use your real GitHub username and repo name.

---

## 2. Supabase: allow dashboard access

In Supabase:

1. **Table Editor** → `bot_config` → make sure the table exists and has a row with `id = 'default'`.
2. **Authentication** → **Policies** (or **Table Editor** → click table → “RLS”).
3. For **bot_config**: add a policy so the anon key can read and update that row, e.g.:
   - **SELECT:** `true` (or `id = 'default'`).
   - **UPDATE:** `id = 'default'`.
4. For **positions**: anon key needs **SELECT** only (e.g. `true`).

If you prefer to keep RLS off for a private project, you can leave policies permissive for anon; the anon key is “public” but only allows what your app does (read config/positions, update config).

---

## 3. Import project in Vercel

1. Go to [vercel.com](https://vercel.com) and log in (with GitHub).
2. **Add New** → **Project**.
3. **Import** your GitHub repo (e.g. `YOUR_USERNAME/CURSORBOT`).
4. **Configure:**
   - **Root Directory:** click **Edit** and set to **`dashboard`** (so Vercel builds the Next.js app in that folder).
   - **Framework Preset:** should detect Next.js.
   - **Build Command:** leave default (`next build`).
   - **Output Directory:** leave default.
5. **Environment Variables** — add these (click “Add” for each):

   | Name | Value |
   |------|--------|
   | `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL (e.g. `https://xxxxx.supabase.co`) |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Your Supabase anon (public) key |

6. Click **Deploy**.

---

## 4. Open the dashboard

When the deploy finishes, Vercel shows a URL like `https://cursorbot-xxx.vercel.app`. Open it.

You should see:

- **Emergency OFF** / **Resume**
- **Position sizes** (Kalshi / Polymarket) and **Save**
- **Recent positions** table (empty until the bot logs some)

Use this URL whenever you want to pause the bot or change sizes.

---

## 5. Optional: custom domain

In the Vercel project: **Settings** → **Domains** → add your domain and follow the DNS instructions.

---

## Summary

- **GitHub:** repo contains both the bot (root) and the dashboard (`dashboard/`).
- **Vercel:** root directory = `dashboard`, two env vars for Supabase.
- **Supabase:** anon key can read `bot_config` and `positions`, and update `bot_config`.

No other secrets or proxy info are needed for the dashboard; it only talks to Supabase.
