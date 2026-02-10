/**
 * Redeem resolved Polymarket positions (CTF) on Polygon.
 * Uses POLYMARKET_PRIVATE_KEY, POLYMARKET_FUNDER, and POLYGON_RPC_URL from .env.
 *
 * Auto-discovery: with no args and no CONDITION_IDS, fetches redeemable positions
 * from Polymarket Data API (user=POLYMARKET_FUNDER) and redeems each conditionId.
 *
 * Usage:
 *   node dist/scripts/claim-polymarket.js [conditionId1] [conditionId2] ...
 *   Or set CONDITION_IDS=id1,id2 in .env. Or run with no args for auto-discovery.
 *
 * Cron runs at :05, :20, :35, :50 each hour; uses proxy if HTTP_PROXY/HTTPS_PROXY set.
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import { CTF_ADDRESS, USDC_POLYGON, CTF_ABI } from '../polymarket/ctf-constants.js';

const DATA_API_BASE = 'https://data-api.polymarket.com';
const PARENT_COLLECTION_NULL = '0x' + '0'.repeat(64);
const INDEX_SETS_BINARY = [1, 2]; // Yes | No

function getConditionIdsFromEnvOrArgs(): string[] {
  const envIds = process.env.CONDITION_IDS?.trim();
  if (envIds) return envIds.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
  const args = process.argv.slice(2);
  return args.filter((a) => /^0x[a-fA-F0-9]{64}$/.test(a) || /^[a-fA-F0-9]{64}$/.test(a));
}

/** Fetch redeemable position condition IDs for a user from Polymarket Data API. Uses HTTP_PROXY/HTTPS_PROXY if set. */
async function fetchRedeemableConditionIds(funder: string): Promise<string[]> {
  const url = `${DATA_API_BASE}/positions?user=${encodeURIComponent(funder)}&redeemable=true&limit=500`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Data API positions ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { conditionId?: string }[];
  const ids = new Set<string>();
  for (const row of data) {
    const c = row.conditionId?.trim();
    if (!c) continue;
    const normalized = c.startsWith('0x') ? c : `0x${c}`;
    if (/^0x[a-fA-F0-9]{64}$/.test(normalized)) ids.add(normalized);
  }
  return [...ids];
}

async function main() {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY?.trim();
  const funder = process.env.POLYMARKET_FUNDER?.trim();
  const rpcUrl = process.env.POLYGON_RPC_URL?.trim() || 'https://polygon-mainnet.g.alchemy.com/v2/J6wjUKfJUdYzPD5QNDd-i';
  if (!privateKey) {
    console.error('Missing POLYMARKET_PRIVATE_KEY in .env');
    process.exit(1);
  }

  let conditionIds = getConditionIdsFromEnvOrArgs();
  if (conditionIds.length === 0 && funder) {
    try {
      console.log('Discovering redeemable positions for', funder, '...');
      conditionIds = await fetchRedeemableConditionIds(funder);
      if (conditionIds.length > 0) console.log('Found', conditionIds.length, 'redeemable condition(s)');
    } catch (e) {
      console.error('Discovery failed:', e);
      process.exit(1);
    }
  }
  if (conditionIds.length === 0) {
    console.log('No condition IDs to redeem (no args, no CONDITION_IDS, and no redeemable positions from Data API).');
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
