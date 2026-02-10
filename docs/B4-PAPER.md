# B4 paper trader

B4 is a **paper-only** bot: it does not place real orders. It watches **BTC, ETH, and SOL** 15‑minute Polymarket markets and logs whether a 54→56 buy and 60 sell would have been possible.

## Logic

- **Assets:** BTC, ETH, SOL (same rules for each).
- **First 3 minutes:** Check every 1 second. If **yes** or **no** price reaches **54¢+**, log **BUY_56_POSSIBLE** (entry in that direction). If that same side reaches **60¢+** in the first 3 min, log **60_POSSIBLE** immediately. If we never hit 54¢ in the first 3 min, log **NO_ENTRY** once when the 3 min end.
- **After first 3 minutes:** If we entered (hit 54¢), then **every 30 seconds** (at 3:00, 3:30, 4:00, … until window end) check if that side’s price is **60¢+**. If yes, log **60_POSSIBLE**. If the window ends and we had entered but never hit 60¢, log **LOSS**.
- **Summary per asset per window:** Exactly one of: **NO_ENTRY** (never hit 54), **LOSS** (hit 54, never hit 60), or **60_POSSIBLE** (hit 54 and later 60).

## Run

From repo root (after `npm run build`):

```bash
npm run b4-paper
```

Or:

```bash
node dist/scripts/b4-paper.js
```

On the droplet, use the same proxy as the main bot if needed (set `HTTP_PROXY` / `HTTPS_PROXY`). Run in the background with `nohup` or a separate systemd service if you want it always on.

## Run on droplet (keep it running)

After deploying (`git pull && npm run build`):

```bash
# Option A: nohup (survives disconnect; log in b4-paper.log)
cd /root/cursorbot && nohup node dist/scripts/b4-paper.js >> b4-paper.log 2>&1 &

# Option B: systemd (restarts on crash/reboot; recommended)
sudo cp /root/cursorbot/deploy/cursorbot-b4.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now cursorbot-b4
```

Events are also written to Supabase **`b4_paper_log`** (with an **asset** column); the dashboard shows the last 20 rows at the bottom. If Supabase is down (e.g. 500), the file log still gets the line but the dashboard won’t show it until Supabase is back.

**If `b4_paper_log` already exists** without an `asset` column, run in Supabase SQL:  
`ALTER TABLE b4_paper_log ADD COLUMN asset text DEFAULT 'BTC';`

## Log file

Events are appended to **`b4-paper.log`** in the current working directory (e.g. `/root/cursorbot/b4-paper.log` on the droplet).

**Example lines:**

```
2026-02-10T19:00:01.234Z | window=1770749100 | asset=BTC | event=BUY_56_POSSIBLE | direction=yes | price=0.542
2026-02-10T19:00:45.678Z | window=1770749100 | asset=BTC | event=60_POSSIBLE | direction=yes | price=0.601
2026-02-10T19:01:00.000Z | B4 fetch failed asset=ETH slug=eth-updown-15m-1770749100 err=Gamma event ... 404
```

## View or download the log

**On the droplet:**

```bash
# View last 50 lines
tail -50 /root/cursorbot/b4-paper.log

# Follow live
tail -f /root/cursorbot/b4-paper.log

# Count 60_POSSIBLE (entered and hit 60)
grep 60_POSSIBLE /root/cursorbot/b4-paper.log | wc -l
```

**Download to your machine:**

```bash
scp -i .ssh/cursorbot_droplet root@188.166.15.165:/root/cursorbot/b4-paper.log ./
```

Each **60_POSSIBLE** line is a window where we entered at 54¢+ and later saw 60¢+ in that direction. **NO_ENTRY** = never hit 54 in first 3 min. **LOSS** = hit 54 but never hit 60 by window end.
