# Cursorbot Dashboard

Minimal control panel: emergency off and position sizes.

## Setup

1. `npm install`
2. Create `.env.local`:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
   ```
3. In Supabase, allow the anon key to:
   - `SELECT` and `UPDATE` on `bot_config` (e.g. for `id = 'default'`)
   - `SELECT` on `positions`

## Run

- Dev: `npm run dev` → http://localhost:3000
- Build: `npm run build && npm run start`

## Deploy to Vercel

1. Push the repo and import the `dashboard` folder (or root with root as dashboard) as a Vercel project.
2. Set env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
3. Deploy.
