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

## In-repo claim script (auto-discovery)

The script calls the CTF contract’s `redeemPositions` using `POLYMARKET_PRIVATE_KEY` and `POLYGON_RPC_URL`. **With no arguments and no `CONDITION_IDS`, it automatically discovers redeemable positions** for your wallet via the Polymarket Data API (`user=POLYMARKET_FUNDER`) and redeems each one.

**Cron on the droplet** (already configured) runs at **:05, :20, :35, :50** every hour:

```bash
5,20,35,50 * * * * cd /root/cursorbot && /usr/bin/node dist/scripts/claim-polymarket.js
```

No need to set `CONDITION_IDS`; the script fetches redeemable positions and redeems them. Uses `HTTP_PROXY`/`HTTPS_PROXY` if set. You need a small amount of **POL** on Polygon to pay gas.

**Optional:** To redeem only specific markets, set `CONDITION_IDS=id1,id2` in `.env` or pass condition IDs as arguments. **Manual:** Claim from the Polymarket UI (portfolio → resolved positions → Claim).
