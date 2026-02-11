# B4 Kalshi 46/50 (BTC only)

**BTC only, Kalshi only.** No Polymarket. No B4 paper logging.

## Strategy

1. At the start of each 15m window, place **two** resting limit **buys** at **46¢**:
   - One **YES** @ 46¢  
   - One **NO** @ 46¢  
   (Position size **$1** (1 contract per side).)

2. **Poll every 1 second**: check both orders (fill count).
   - As soon as **one** has a fill:
     - **Cancel** the other order (so it doesn’t fill later).
     - **Place** a resting limit **sell** at **50¢** for the side that filled (same count as filled).
   - That gives at least a **4¢** spread (buy 46, sell 50).

3. Near end of window (e.g. &lt; 1 min left), if neither filled, cancel both resting orders. On the next window, place a fresh pair of 46¢ orders.

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
