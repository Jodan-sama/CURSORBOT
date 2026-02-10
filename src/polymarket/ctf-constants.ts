/**
 * Polygon addresses for Polymarket CTF (Conditional Token Framework) redemption.
 * @see https://docs.polymarket.com/developers/CTF/deployment-resources
 * @see https://docs.polymarket.com/developers/CTF/redeem
 */

/** CTF contract on Polygon mainnet. */
export const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as const;

/** USDC (bridged USDC.e) on Polygon – Polymarket collateral. */
export const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as const;

/** Minimal ABI for redeemPositions. Parent collection null for Polymarket binary; indexSets [1,2] = Yes|No. */
export const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
] as const;
