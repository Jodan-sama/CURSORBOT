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

## What we need to add

A **claim** step (script or bot step) that:

1. Reads resolved positions (e.g. from our `positions` table for Polymarket, or from the CLOB/API).
2. For each winning position, calls the CTF contract’s `redeemPositions` from your **wallet** (same key as `POLYMARKET_PRIVATE_KEY`).
3. Uses the correct **CTF contract address** and **collateral (USDC)** address on Polygon (from Polymarket’s deployment docs).

Implementation options:

- **Node script**: Use `ethers` with your wallet, get CTF ABI and addresses from Polymarket’s CTF docs, call `redeemPositions` for each condition/position.
- **Manual**: Claim from the Polymarket UI (portfolio → resolved positions → Claim).

If you want this automated in-repo, the next step is to add a small `src/polymarket/redeem.ts` (or a `scripts/claim-polymarket.ts`) that uses your existing Polymarket wallet and the CTF contract addresses from the docs.
