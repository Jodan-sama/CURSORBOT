# B123c “Up 4c” wrong-side bug — root cause and fix

## What happened

- We intended to buy **Down** at **96c** (spread was negative; strategy correct).
- Logs showed: `LIMIT BUY no price=0.96` and `B1c SOL no 96c placed`.
- On Polymarket the position appeared as **“Up 4c”** and **resolved as a loss** (market went Up).

So we actually bought the **Up** outcome (wrong side). The fill at **4c** is consistent with taking the best ask on the **Up** book (losing side was cheap).

## Root cause

We chose the CLOB token by **index** only:

- `side === 'yes'` → `clobTokenIds[0]`
- `side === 'no'`  → `clobTokenIds[1]`

We assumed Gamma’s `outcomes` and `clobTokenIds` are always ordered as `[Up, Down]` (index 0 = Up, 1 = Down). For at least one market (or slug/timing), the API returned them in the **opposite** order (`[Down, Up]`). Then:

- We wanted Down → we used `side = 'no'` → we took **index 1** → we got the **Up** token.
- We sent a limit buy at 0.96 on the Up token; the book had asks at ~4c, so we got filled at **4c** → “Up 4c” and a loss when Up won.

So the bug was **wrong token selection when Gamma’s outcome order differed from our assumption**.

## Fix (implemented)

1. **Resolve token by outcome name, not index**
   - New helper: `getTokenIdForOutcome(market, wantUp)` in `src/polymarket/gamma.ts`.
   - It finds the outcome `"Up"` or `"Down"` (or `"Yes"` / `"No"`) in `market.outcomes` and uses the **same index** into `market.clobTokenIds`. So we always buy the correct side regardless of array order.

2. **Use this in all Polymarket order paths**
   - **B123c** (`b123c-runner.ts`): `placeLimitOrder` uses `getTokenIdForOutcome(market, side === 'yes')`.
   - **B4** (`b4-5m/spread-runner.ts`): same in `placeLimitOrder`.
   - **B5** (`b5-5m/spread-runner.ts`): same in `placeLimitOrder`.
   - **Shared** (`polymarket/clob.ts`): `orderParamsFromParsedMarket` uses `getTokenIdForOutcome(parsed, side === 'yes')`.

3. **Logging**
   - Logs now include the outcome name, e.g. `LIMIT BUY Down (no) price=0.96 …` so we can confirm we’re buying Down when spread is negative.

## Deploy

After pulling, rebuild and restart on D2 (B123c + B4) and D3 (B5) so all bots use the new token resolution.
