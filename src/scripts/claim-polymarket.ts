/**
 * Redeem resolved Polymarket positions (CTF) on Polygon.
 * Uses POLYMARKET_PRIVATE_KEY and POLYGON_RPC_URL from .env.
 *
 * Usage:
 *   node dist/scripts/claim-polymarket.js [conditionId1] [conditionId2] ...
 *   Or set CONDITION_IDS=id1,id2 in .env and run without args.
 *
 * For cron (e.g. hourly): add to crontab -e
 *   0 * * * * cd /root/cursorbot && node dist/scripts/claim-polymarket.js
 * If you have condition IDs to redeem, pass them or set CONDITION_IDS.
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import { CTF_ADDRESS, USDC_POLYGON, CTF_ABI } from '../polymarket/ctf-constants.js';

const PARENT_COLLECTION_NULL = '0x' + '0'.repeat(64);
const INDEX_SETS_BINARY = [1, 2]; // Yes | No

function getConditionIds(): string[] {
  const envIds = process.env.CONDITION_IDS?.trim();
  if (envIds) return envIds.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
  const args = process.argv.slice(2);
  return args.filter((a) => /^0x[a-fA-F0-9]{64}$/.test(a) || a.length === 64);
}

async function main() {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY?.trim();
  const rpcUrl = process.env.POLYGON_RPC_URL?.trim() || 'https://polygon-mainnet.g.alchemy.com/v2/J6wjUKfJUdYzPD5QNDd-i';
  if (!privateKey) {
    console.error('Missing POLYMARKET_PRIVATE_KEY in .env');
    process.exit(1);
  }

  const conditionIds = getConditionIds();
  if (conditionIds.length === 0) {
    console.log('No condition IDs to redeem. Pass them as args or set CONDITION_IDS=id1,id2');
    process.exit(0);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`, provider);
  const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);

  for (const rawId of conditionIds) {
    const conditionId = rawId.startsWith('0x') ? rawId : `0x${rawId}`;
    if (conditionId.length !== 66) {
      console.warn('Skipping invalid conditionId:', rawId);
      continue;
    }
    try {
      const tx = await ctf.redeemPositions(
        USDC_POLYGON,
        PARENT_COLLECTION_NULL,
        conditionId,
        INDEX_SETS_BINARY
      );
      console.log('Redeem tx sent:', conditionId, tx.hash);
      await tx.wait();
      console.log('Redeemed:', conditionId);
    } catch (e) {
      console.error('Redeem failed for', conditionId, e);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
