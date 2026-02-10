# B4 paper trader

B4 is a **paper-only** bot: it does not place real orders. It watches **BTC, ETH, and SOL** 15‑minute Polymarket markets in the **first 3 minutes** of each window and logs when a 54→56 buy and 60 sell would have been possible.

## Logic

- **Assets:** BTC, ETH, SOL (same rules for each).
- **Window:** First 3 minutes of each 15m market (e.g. :00–:03, :15–:18, :30–:33, :45–:48).
- **Check:** Every 1 second (market prices from Gamma). If a fetch fails, the error is written to `b4-paper.log` (asset, slug, error) so you can debug.
- **Entry:** If **yes** or **no** price reaches **54¢+** (0.54), log “buy at 56 possible” in that direction.
- **Exit:** When that same side reaches **60¢+** (0.60), log “sell at 60 possible”.
- **Once per cycle:** One entry and one exit per asset per 15m window; then it waits for the next window.

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
2026-02-10T19:00:45.678Z | window=1770749100 | asset=BTC | event=SELL_60_POSSIBLE | direction=yes | price=0.601
2026-02-10T19:01:00.000Z | B4 fetch failed asset=ETH slug=eth-updown-15m-1770749100 err=Gamma event ... 404
```

## View or download the log

**On the droplet:**

```bash
# View last 50 lines
tail -50 /root/cursorbot/b4-paper.log

# Follow live
tail -f /root/cursorbot/b4-paper.log

# Count successes (both buy and sell in same window)
grep SELL_60_POSSIBLE /root/cursorbot/b4-paper.log | wc -l
```

**Download to your machine:**

```bash
scp -i .ssh/cursorbot_droplet root@188.166.15.165:/root/cursorbot/b4-paper.log ./
```

Then open `b4-paper.log` locally. Each `SELL_60_POSSIBLE` line is a cycle where both the 56 buy and 60 sell were possible.
