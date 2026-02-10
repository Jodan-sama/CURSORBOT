# Claiming winnings on Polymarket

After a market resolves, winning conditional tokens can be **redeemed** for USDC by calling the CTF (Conditional Token Framework) contract on Polygon.

## How it works

Polymarket’s docs: [Redeeming Tokens](https://docs.polymarket.com/developers/CTF/redeem).

- Once the condition has **payouts reported** (via UMA/CTF adapter), holders of the winning outcome can call **`redeemPositions`** on the CTF contract.
- That **burns** the winning conditional tokens and credits the underlying collateral (USDC) to your wallet.

## Contract parameters

`redeemPositions` takes:

- **collateralToken**: USDC address on Polygon.
- **parentCollectionId**: `bytes32` – null for Polymarket’s binary markets.
- **conditionId**: The market’s condition ID (we have this from Gamma, e.g. in `positions.ticker_or_slug` or from the market’s `conditionId`).
- **indexSets**: For binary (Yes/No), typically `[1, 2]` (both outcome sets) – exact values depend on the CTF encoding; see [Deployment and Additional Information](https://docs.polymarket.com/developers/CTF/deployment-resources).

## In-repo claim script

The project includes a script that calls the CTF contract’s `redeemPositions` using your Polymarket wallet (`POLYMARKET_PRIVATE_KEY`) and `POLYGON_RPC_URL`.

**Run once (with condition IDs):**

```bash
# After build
node dist/scripts/claim-polymarket.js <conditionId1> [conditionId2] ...
# Or set CONDITION_IDS=id1,id2 in .env and run:
npm run claim-poly
```

**Cron (e.g. hourly):** If you have condition IDs to redeem, pass them via env or args. Example:

```bash
crontab -e
# Add (run every hour):
0 * * * * cd /root/cursorbot && /usr/bin/node dist/scripts/claim-polymarket.js
```

To redeem specific markets, set `CONDITION_IDS` in `.env` (comma-separated) or pass condition IDs as script arguments. You need a small amount of POL on Polygon to pay gas for the redeem tx.

**Manual option:** Claim from the Polymarket UI (portfolio → resolved positions → Claim).
