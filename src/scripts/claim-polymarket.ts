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

type PositionRow = { conditionId?: string; redeemable?: boolean; proxyWallet?: string };

/** Fetch positions from Data API (optionally with redeemable filter). Uses HTTP_PROXY/HTTPS_PROXY if set. */
async function fetchPositions(user: string, redeemableOnly: boolean): Promise<PositionRow[]> {
  const params = new URLSearchParams({ user, limit: '500' });
  if (redeemableOnly) params.set('redeemable', 'true');
  const url = `${DATA_API_BASE}/positions?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Data API positions ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as PositionRow[];
}

/** Collect condition IDs from position rows (optionally only redeemable). */
function conditionIdsFromRows(rows: PositionRow[], requireRedeemable: boolean): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (requireRedeemable && !row.redeemable) continue;
    const c = row.conditionId?.trim();
    if (!c) continue;
    const normalized = c.startsWith('0x') ? c : `0x${c}`;
    if (/^0x[a-fA-F0-9]{64}$/.test(normalized)) ids.add(normalized);
  }
  return [...ids];
}

/** Fetch redeemable condition IDs: try API redeemable filter first, then fallback to all positions + client-side filter. */
async function fetchRedeemableConditionIds(funder: string): Promise<string[]> {
  // 1) Try with redeemable=true
  const withFilter = await fetchPositions(funder, true);
  let ids = conditionIdsFromRows(withFilter, true);
  if (ids.length > 0) return ids;

  // 2) Fallback: fetch all positions and filter for redeemable (Data API sometimes returns empty for redeemable=true)
  const all = await fetchPositions(funder, false);
  const redeemableCount = all.filter((r) => r.redeemable).length;
  if (redeemableCount > 0) {
    console.log(`Found ${redeemableCount} redeemable position(s) via fallback (all positions).`);
    ids = conditionIdsFromRows(all, true);
  }
  return ids;
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
      const proxy = process.env.POLYMARKET_PROXY_WALLET?.trim();
      const addressesToTry = proxy ? [funder, proxy] : [funder];
      for (const addr of addressesToTry) {
        console.log('Discovering redeemable positions for', addr, '...');
        const ids = await fetchRedeemableConditionIds(addr);
        if (ids.length > 0) {
          conditionIds = ids;
          console.log('Found', conditionIds.length, 'redeemable condition(s)');
          break;
        }
      }
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
