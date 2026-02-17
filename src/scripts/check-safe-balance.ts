/**
 * Check USDC balance in the Polymarket Safe (PolyGun).
 * Uses POLYGON_RPC_URL and POLYMARKET_SAFE_ADDRESS / POLYGUN_CLAIM_FUNDER from .env.
 *
 * Usage: npm run check-safe-balance
 */
import 'dotenv/config';
import { ethers } from 'ethers';

const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const DEFAULT_SAFE = '0xBDD5AD35435bAb6b3AdF6A8E7e639D0393263932';

const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
] as const;

async function main() {
  const rpcUrl = process.env.POLYGON_RPC_URL?.trim() || 'https://polygon-mainnet.g.alchemy.com/v2/J6wjUKfJUdYzPD5QNDd-i';
  const safeAddress =
    process.env.POLYGUN_CLAIM_SAFE_ADDRESS?.trim() ||
    process.env.POLYMARKET_SAFE_ADDRESS?.trim() ||
    DEFAULT_SAFE;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const usdc = new ethers.Contract(USDC_POLYGON, ERC20_ABI, provider);
  const balance = await usdc.balanceOf(safeAddress);

  console.log('Safe address:', safeAddress);
  console.log('USDC balance:', ethers.formatUnits(balance, 6));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
