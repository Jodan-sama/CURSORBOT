# B4 Kalshi 46/50 (BTC, ETH, SOL)

**BTC, ETH, SOL. Kalshi only.** No Polymarket. Results logged to `b4_paper_log` and shown on the dashboard.

## Strategy

1. At the start of each 15m window, place **one** resting limit **buy** per asset: **YES @ 46¢** (position size **$1** = 1 contract per asset). So one resting order per asset per round; only one can fill.

2. **Poll every 1 second**: check the order (fill count).
   - When it fills: **place** a resting limit **sell** at **50¢** for YES (same count). That gives a **4¢** spread (buy 46, sell 50).

3. Near end of window (e.g. &lt; 1 min left), if not filled, cancel the resting order and log no_fill. On the next window, place a fresh 46¢ YES order per asset.

## Run

After `npm run build`:

```bash
npm run b4-kalshi-46-50
```

Or:

```bash
node dist/scripts/b4-kalshi-46-50.js
```

**Env:** Uses existing Kalshi and Supabase env. **Emergency off:** when the dashboard emergency off button is on, this bot does nothing (checks every tick).

## Droplet

```bash
sudo cp /root/cursorbot/deploy/cursorbot-b4-46-50.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now cursorbot-b4-46-50
```

## API

- **Cancel order:** `DELETE /portfolio/orders/{order_id}` — supported; used to cancel the unfilled 46¢ order.
- **Get order:** `GET /portfolio/orders/{order_id}` — used to read `fill_count` every second.
- Create order (existing) for the two 46¢ buys and the 50¢ sell.
