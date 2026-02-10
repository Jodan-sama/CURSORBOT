# Deploying Cursorbot

## 1. Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. In **SQL Editor**, run the schema: paste and run contents of `supabase/schema.sql`.
3. (Optional) In **Authentication > Policies** or **Table Editor**, enable RLS and add a policy so your dashboard can update `bot_config` (e.g. allow anon or authenticated to update `bot_config` where `id = 'default'`). For a simple setup you can use the anon key with a policy that allows `SELECT` on `positions` and `bot_config`, and `UPDATE` on `bot_config` for `id = 'default'`.
4. Copy **Project URL** and **anon public** key into `.env` as `SUPABASE_URL` and `SUPABASE_ANON_KEY`.

## 2. Run the bot on a DigitalOcean droplet

1. Create a droplet (Ubuntu 22+, 1 vCPU is enough). SSH in.
2. Install Node 20+: `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs`
3. Clone the repo (or copy files). Add a `.env` with all required vars (Kalshi, Polymarket, Supabase, and optionally `HTTP_PROXY`/`HTTPS_PROXY` for Polymarket).
4. Build and run:
   ```bash
   npm ci
   npm run build
   npm run bot
   ```
5. Run in the background: use `tmux`, `screen`, or a process manager.
   - **systemd** (recommended): create `/etc/systemd/system/cursorbot.service`:
     ```ini
     [Unit]
     Description=Cursorbot 15M trading
     After=network.target

     [Service]
     Type=simple
     User=YOUR_USER
     WorkingDirectory=/path/to/CURSORBOT
     EnvironmentFile=/path/to/CURSORBOT/.env
     ExecStart=/usr/bin/node /path/to/CURSORBOT/dist/bot/run.js
     Restart=on-failure
     RestartSec=10

     [Install]
     WantedBy=multi-user.target
     ```
     Then: `sudo systemctl daemon-reload && sudo systemctl enable cursorbot && sudo systemctl start cursorbot && sudo systemctl status cursorbot`

### Polymarket proxy (optional)

If Polymarket orders must go through Proxy Empire, set before starting the process:

```bash
export HTTP_PROXY="http://USER:PASS@v2.proxyempire.io:5000"
export HTTPS_PROXY="$HTTP_PROXY"
npm run bot
```

Node’s built-in `fetch` may not use these. If orders still don’t use the proxy, use a global HTTP agent (e.g. `global-agent`) or run the bot in a environment that forces all HTTP through the proxy.

## 3. Control dashboard (emergency off + position sizes)

A minimal dashboard can run on **Vercel** (or any static host) and talk to Supabase:

1. **Supabase:** Ensure `bot_config` is readable and updatable by the anon key (or use a small backend with a service key).
2. **Dashboard app:** In this repo, `dashboard/` is a minimal Next.js or static app that:
   - Reads `bot_config` and `positions` from Supabase.
   - Has an **Emergency OFF** button that sets `bot_config.emergency_off = true` (and optionally an ON that sets `false`).
   - Has a form to set `position_size_kalshi` and `position_size_polymarket` (and optionally per-bot/asset in `bot_position_sizes`).
3. Deploy the dashboard to Vercel, set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or equivalent) in the project env.

See `dashboard/README.md` for dashboard setup and Vercel deploy.

## 4. Checklist before going live

- [ ] `.env` on the droplet has all keys (Kalshi, Polymarket, Supabase); no keys in git.
- [ ] Supabase schema applied; RLS allows dashboard to read/write what it needs.
- [ ] Bot runs under systemd (or similar) and restarts on failure.
- [ ] Dashboard is deployed and you can toggle emergency off and change position sizes.
- [ ] Test with small sizes first; confirm positions show up in `positions` and in the dashboard.
