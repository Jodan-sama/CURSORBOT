# B5 Spread Bot on D3 — Updated Plan

**Full B4 parity for ETH/SOL/XRP 5m; B5-specific state, blocks, early guard; website inputs; claim every 5 min.**

---

## 1. Scope and constraints

- **D3 only.** No changes to D1 or D2 (except resolver + dashboard as below).
- **Erase current B5 on D3:** Stop/disable `cursorbot-b5` (basket bot). Replace with new B5 spread runner.
- **Wallet:** Use existing D3 `.env` (POLYMARKET_PRIVATE_KEY, POLYMARKET_FUNDER, POLYMARKET_DERIVE_KEY, etc.). Already used for trading; no new wallet setup.
- **All B5 UI and config** lives **after all current content** on the website (new section at the very bottom).

---

## 2. Copy every element of B4 (no skipping)

B5 must have the same logic and persistence as B4:

| B4 element | B5 equivalent | Notes |
|------------|---------------|--------|
| **b4_state** | **b5_state** | Single row id='default': bankroll, max_bankroll, cooldown_until_ms (pause), results_json (tier config + **position_size** + early_guard_spread_pct + early_guard_cooldown_min), etc. |
| **b4_tier_blocks** | **b5_tier_blocks** | t1_blocked_until_ms, t2_blocked_until_ms. Read on startup; write when T2/T3 places. |
| **b4_early_guard** | **b5_early_guard** | cooldown_until_ms. Early-window high-spread guard. |
| Tier config (t1/t2/t3 spread, t2_block_min, t3_block_min) | Same fields in b5_state.results_json | B5 has its own numbers (you'll provide); stored in DB, editable on website. |
| **Position size** | One value in b5_state.results_json | Same size for all B5 trades (ETH/SOL/XRP). **B5 has its own position size** — separate from B4. Field on website. |
| Early guard (spread % threshold, cooldown min) | Same in b5_state.results_json | Editable on website. |
| Pause / Resume / Reset | Same pattern | cooldown_until_ms = 1 for pause, 0 for run. Reset clears bankroll/counters and tier blocks/early guard. |
| T3 window end (no T3 after T2 starts) | Same logic | T3 only in [100s, 180s); same blocking rules per asset. |
| Stale spread check, no-Chainlink handling | Same | Per-asset window open/spot from B5 price feed. |
| Derive + proxy for orders | Same | getOrCreateDerivedPolyClient(); apply proxy at process start (HTTPS_PROXY from D3 .env). |

**New Supabase tables (mirror B4):**

- **b5_state** — same shape as b4_state (id, bankroll, max_bankroll, consecutive_losses, cooldown_until_ms, results_json, daily_start_bankroll, daily_start_date, half_kelly_trades_left, updated_at). results_json holds: t1_spread, t2_spread, t3_spread, t2_block_min, t3_block_min, **position_size** (B5 only, no b123c), early_guard_spread_pct, early_guard_cooldown_min.
- **b5_tier_blocks** — same as b4_tier_blocks (id, t1_blocked_until_ms, t2_blocked_until_ms, updated_at).
- **b5_early_guard** — same as b4_early_guard (id, cooldown_until_ms, updated_at).

Add migration (e.g. `supabase/migrations/YYYYMMDD_b5_state_tables.sql`) and document in supabase/schema.sql.

---

## 3. Code: B5 5m spread runner (full B4 clone)

- **Directory:** `src/b5-5m/`.
- **Clock/slug:** Same 5m window; slug per asset: `eth-updown-5m-{start}`, `sol-updown-5m-{start}`, `xrp-updown-5m-{start}` (verify these exist on Polymarket).
- **Price feed:** Multi-asset Chainlink (ETH, SOL, XRP) via RTDS, same pattern as B123c; per-asset getWindowOpen(asset), getSpotPrice(asset), 2-min retry then reset.
- **Spread runner:** Clone of B4 spread-runner with:
  - Loop over assets **['ETH','SOL','XRP']**.
  - Per (window, asset) state: placedThisWindow keys like `B5-T1-${windowStartMs}-ETH`, etc.; **b5_tier_blocks** and **b5_early_guard** (read on startup, write on T2/T3 place and early-guard trigger).
  - Config from **loadB5Config()** (reads b5_state.results_json), **getB5Blocks()**, **updateB5TierBlocks()**, **updateB5EarlyGuard()**, **isB5EmergencyOff()** (cooldown_until_ms in b5_state).
  - Same tier order (T3 → T2 → T1), same T3 window end (180s), same early-guard check (first 100s, spread &gt; threshold → cooldown), same stale-spread check.
  - **logPosition({ bot: 'B5', asset, venue: 'polymarket', ... })**.
- **DB layer:** In `src/db/supabase.ts`: add **'B5'** to BotId; add **loadB5Config**, **saveB5Config**, **getB5Blocks**, **updateB5TierBlocks**, **updateB5EarlyGuard**, **isB5EmergencyOff**, **resetB5State** (mirror B4 APIs, using b5_state / b5_tier_blocks / b5_early_guard).

---

## 4. Dashboard: B5 section (after all content)

- **Placement:** New section at the **very bottom** of [dashboard/app/page.tsx](dashboard/app/page.tsx) (after B1/B2/B3 Pending, etc.).
- **Load:** In `load()`, add:
  - `getSupabase().from('b5_state').select('*').eq('id', 'default').maybeSingle()`
  - `getSupabase().from('positions').select('*').eq('bot', 'B5').order('entered_at', { ascending: false }).limit(200)`
- **State:** `b5State`, `b5Config` (t1_spread, t2_spread, t3_spread, t2_block_min, t3_block_min, **position_size**, early_guard_spread_pct, early_guard_cooldown_min), `b5Positions`.
- **UI (mirror B4):**
  - **B5 — 5-Minute ETH/SOL/XRP (D3)** heading.
  - Status: Running / Paused (from b5_state.cooldown_until_ms).
  - Buttons: **Pause B5**, **Resume B5**, **Reset B5** (confirm; call resetB5State with current config).
  - **B5 Spread Tier Config** form with **input fields** for:
    - T1 spread %, T2 spread %, T3 spread %
    - T2 block min, T3 block min
    - **Position size** (B5 only; one value for all assets)
    - Early guard spread %, Early guard cooldown min
  - **Save** button (saveB5Config).
  - Table: B5 positions (Time, Asset, Spread %, Size, Result, etc.), same style as B4.
  - Optional: B5 win rate (resolved) in the existing “Win rate (resolved)” block.

Use your new numbers as **defaults** in code and in the migration (e.g. seed b5_state.results_json); user can override via the website.

---

## 5. Resolver and claim

- **Resolver (D2):** Add **'B5'** to positions query. Add **b5Client** from **.env.b5** on D2 (D3 B5 wallet credentials) for getOrder; use it when row.bot === 'B5'. Set outcome/resolved_at as for B4.
- **Claim on D3:** Systemd timer every 5 min at :02,:07,:12,... (deploy-d3-b5.sh installs cursorbot-claim-b5.timer; persists across reboot).

---

## 6. Proxy

**You do not need to create anything new.** We will use whatever `HTTPS_PROXY` is already in D3 `.env`. With plenty of Proxy Empire data left, you are fine. If you ever want B5 to use a separate session (e.g. a different sid from your generated list), you could add a second proxy URL and we could wire B5 to it, but it is optional — one proxy on D3 is sufficient.

**What goes through the proxy (for reference):** If D3 has its own `HTTPS_PROXY`, B5’s RTDS + CLOB traffic goes only through D3’s proxy. No extra load on D2. Chainlink is one subscription (multiple symbols); CLOB is request-based. **Unlikely to be rate limited by Chainlink** (one connection, few symbols). Polymarket CLOB limits (if any) are typically per-wallet or per-IP; B5 is a separate wallet on D3. If D3 shared a proxy with D2, you’d add one more RTDS connection and more CLOB traffic; a dedicated proxy for D3 avoids any risk to D1/D2. **Conclusion:** Proxy should be okay; use a dedicated proxy for D3 if you want to be sure nothing affects the other bots.

---

## 7. B5 config numbers (defaults)

**Block timing:** Same as B4 — T2 block **5 min**, T3 block **15 min** (defaults; editable on website).

**Early guard:** **0.45%** for all assets (ETH, SOL, XRP). Single field on website: early_guard_spread_pct = 0.45.

**Per-asset tier spreads (T1 / T2 / T3):**

| Asset | T1 spread % | T2 spread % | T3 spread % |
|-------|----------------|--------------|--------------|
| ETH   | 0.32           | 0.181        | 0.110        |
| SOL   | 0.32           | 0.206        | 0.121        |
| XRP   | 0.32           | 0.206        | 0.121        |

- **Early protect:** 0.45 for all (same as early_guard_spread_pct).
- **Position size:** One value for B5 (all assets). Default **5** unless you specify; editable on website.
- **Early guard cooldown (min):** Same as B4 default **60** unless you specify.

Storage: `b5_state.results_json` holds **per-asset** spreads (e.g. `eth_t1_spread`, `eth_t2_spread`, `eth_t3_spread`, `sol_t1_spread`, … `xrp_t3_spread`) plus `early_guard_spread_pct`, `t2_block_min`, `t3_block_min`, `position_size`, `early_guard_cooldown_min`. Dashboard: input fields per asset (ETH T1/T2/T3, SOL T1/T2/T3, XRP T1/T2/T3) plus shared early guard, block mins, position size, cooldown min.

---

## 8. Implementation order

1. Supabase: add **b5_state**, **b5_tier_blocks**, **b5_early_guard** (migration + schema.sql); seed b5_state.results_json with per-asset spreads and defaults above.
2. **src/db/supabase.ts:** BotId + 'B5'; loadB5Config (returns per-asset spreads + shared fields), saveB5Config, getB5Blocks, updateB5TierBlocks, updateB5EarlyGuard, isB5EmergencyOff, resetB5State.
3. **src/b5-5m/:** price-feed (multi-asset ETH/SOL/XRP), clock/slug, spread-runner (full B4 logic, per-asset tier spreads from config, b5_* state), spread-run.ts.
4. **deploy/cursorbot-b5-spread.service** (ExecStart: node dist/b5-5m/spread-run.js).
5. **Resolver:** add B5 to query; b5Client from .env.b5 on D2.
6. **Dashboard:** load b5_state + B5 positions; B5 section at bottom with status, Pause/Resume/Reset; tier config form with **per-asset** T1/T2/T3 (ETH, SOL, XRP), shared early_guard_spread_pct (0.45), t2_block_min, t3_block_min, position_size, early_guard_cooldown_min; Save; positions table; optional B5 win rate.
7. **D3:** Stop old B5; deploy; enable cursorbot-b5-spread; ensure claim cron is every 5 min; add .env.b5 on D2 for resolver.
