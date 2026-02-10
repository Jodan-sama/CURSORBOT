# Droplet setup (step-by-step)

## Droplet size

- **Minimum:** 1 vCPU, **1 GB RAM** — enough for the Node bot (light HTTP + Supabase).
- **Recommended:** 1 vCPU, **2 GB RAM** — comfortable headroom for `npm install` and future tweaks.

No need for more unless you run other services on the same box. Pick **Ubuntu 22.04 LTS**.

---

## 1. Create the droplet

1. In DigitalOcean: **Create** → **Droplets**.
2. **Image:** Ubuntu 22.04 (LTS).
3. **Plan:** Basic → **Regular** → **$6/mo (1 GB)** or **$12/mo (2 GB)**.
4. **Datacenter:** Choose one close to you (or leave default).
5. **Authentication:** SSH key (recommended) or password.
6. **Hostname:** e.g. `cursorbot`.
7. Click **Create Droplet**.

---

## 2. Push the repo to GitHub (if you haven’t)

On your Mac (in the project folder):

```bash
cd /Users/jodan/Documents/CURSORBOT
git init
git add .
git commit -m "Initial cursorbot + dashboard"
# Create a new repo on github.com (e.g. YOUR_USERNAME/CURSORBOT), then:
git remote add origin https://github.com/YOUR_USERNAME/CURSORBOT.git
git branch -M main
git push -u origin main
```

Use your real GitHub username and repo name. If the repo already exists, skip or adjust the `git remote` / `git push` step.

---

## 3. SSH into the droplet

From your Mac:

```bash
ssh root@YOUR_DROPLET_IP
```

(Or `ssh ubuntu@...` if you chose that user.) Replace `YOUR_DROPLET_IP` with the IP DigitalOcean shows for the droplet.

---

## 4. Install Node.js 20

Run on the droplet:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

You should see `v20.x.x`.

---

## 5. Clone the repo

```bash
cd /root
git clone https://github.com/YOUR_USERNAME/CURSORBOT.git cursorbot
cd cursorbot
```

Use the same GitHub repo URL as in step 2 (HTTPS is fine; no need for a deploy key for a private repo unless you want one).

---

## 6. Create `.env` on the droplet

Still in `/root/cursorbot` (or whatever path you used):

```bash
nano .env
```

Paste the block below, then **replace every placeholder** with your real values. Use one of your Proxy Empire session IDs for the proxy (e.g. `sid-8kfgdf4g` or another from the list you have).

```env
# Kalshi
KALSHI_BASE_URL=https://api.elections.kalshi.com/trade-api/v2
KALSHI_KEY_ID=your_kalshi_key_id
KALSHI_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
... your full PEM with \n for newlines ...
-----END RSA PRIVATE KEY-----"

# Supabase (from your Supabase project)
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key

# Polymarket
POLYMARKET_PRIVATE_KEY=your_wallet_private_key_hex
POLYMARKET_FUNDER=0x_your_wallet_address
POLYMARKET_API_KEY=your_polymarket_api_key
POLYMARKET_API_SECRET=your_polymarket_api_secret
POLYMARKET_API_PASSPHRASE=your_polymarket_api_passphrase

# Proxy Empire (Polymarket CLOB through proxy)
HTTP_PROXY=http://r_645c6217b5-country-dk-city-copenhagen-sid-8kfgdf4g:759cf83569@v2.proxyempire.io:5000
HTTPS_PROXY=http://r_645c6217b5-country-dk-city-copenhagen-sid-8kfgdf4g:759cf83569@v2.proxyempire.io:5000
```

Save and exit: `Ctrl+O`, Enter, `Ctrl+X`.

---

## 7. Build and run the bot once (test)

```bash
cd /root/cursorbot
npm ci
npm run build
npm run bot
```

You should see “Cursorbot starting …”. Let it run a few seconds, then stop with `Ctrl+C`.

---

## 8. Install as a systemd service (always-on)

Create the service file:

```bash
sudo nano /etc/systemd/system/cursorbot.service
```

Paste this (path is `/root/cursorbot`; if you used another user/dir, change the two paths and `User=`):

```ini
[Unit]
Description=Cursorbot 15M trading
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/cursorbot

# Load .env (including HTTP_PROXY/HTTPS_PROXY)
EnvironmentFile=/root/cursorbot/.env

ExecStart=/usr/bin/node /root/cursorbot/dist/bot/run.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Save and exit (`Ctrl+O`, Enter, `Ctrl+X`).

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable cursorbot
sudo systemctl start cursorbot
sudo systemctl status cursorbot
```

You should see `active (running)`. To watch logs:

```bash
sudo journalctl -u cursorbot -f
```

Exit logs with `Ctrl+C`.

---

## 9. Useful commands later

| Task | Command |
|------|--------|
| View logs | `sudo journalctl -u cursorbot -f` |
| Stop bot | `sudo systemctl stop cursorbot` |
| Start bot | `sudo systemctl start cursorbot` |
| Restart after code change | `cd /root/cursorbot && git pull && npm ci && npm run build && sudo systemctl restart cursorbot` |

---

## If you used a different user or path

- If you created a user `ubuntu`: use `User=ubuntu` and paths like `/home/ubuntu/cursorbot`.
- If you cloned to `/opt/cursorbot`: use `WorkingDirectory=/opt/cursorbot`, `EnvironmentFile=/opt/cursorbot/.env`, and `ExecStart=.../opt/cursorbot/dist/bot/run.js`.

You’re done with the droplet; the bot will restart on reboot and on failure.
