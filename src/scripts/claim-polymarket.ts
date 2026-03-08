/**
 * Redeem resolved Polymarket positions (CTF) on Polygon.
 * Uses POLYMARKET_PRIVATE_KEY, POLYMARKET_FUNDER, POLYGON_RPC_URL, and HTTPS_PROXY/HTTP_PROXY from .env.
 * EOA (normal wallet) flow only — same as B123. No PolyGun/Safe.
 *
 * Auto-discovery: with no args and no CONDITION_IDS, fetches redeemable positions
 * from Polymarket Data API (user=POLYMARKET_FUNDER) and redeems each conditionId.
 *
 * Usage:
 *   node dist/scripts/claim-polymarket.js [conditionId1] [conditionId2] ...
 *   Or set CONDITION_IDS=id1,id2 in .env. Or run with no args for auto-discovery.
 *
 * Runs every 5 min at :02, :07, :12, ... (systemd timer on D2/D3).
 *
 * Logs: date, time, and status (ALL ITEMS CLAIMED | NEED MORE POL | CLAIM INCOMPLETE) to
 *   logs/claim-polymarket.log and Supabase polymarket_claim_log.
 */
import 'dotenv/config';
import { mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';
import { CTF_ADDRESS, USDC_POLYGON, CTF_ABI } from '../polymarket/ctf-constants.js';

/** Apply HTTPS_PROXY/HTTP_PROXY so Data API fetch and RPC use proxy (same as B123/B4/B5). */
async function applyProxy(): Promise<void> {
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '';
  if (!proxy) return;
  const axios = (await import('axios')).default;
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  const undici = await import('undici');
  undici.setGlobalDispatcher(new undici.ProxyAgent(proxy));
  axios.defaults.httpsAgent = new HttpsProxyAgent(proxy);
  axios.defaults.proxy = false;
}

export type ClaimResult = 'ALL ITEMS CLAIMED' | 'NEED MORE POL' | 'CLAIM INCOMPLETE';

function isInsufficientGasError(e: unknown): boolean {
  const s = String(e ?? '');
  return (
    /insufficient funds/i.test(s) ||
    /exceeded the balance/i.test(s) ||
    /balance 0/i.test(s) ||
    /gas \* price \+ value/i.test(s)
  );
}

async function writeClaimLog(message: ClaimResult): Promise<void> {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 8);
  const line = `${dateStr} ${timeStr} ${message}\n`;
  try {
    const logsDir = join(process.cwd(), 'logs');
    mkdirSync(logsDir, { recursive: true });
    appendFileSync(join(logsDir, 'claim-polymarket.log'), line);
  } catch (err) {
    console.error('Could not write claim log:', err);
  }
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_ANON_KEY?.trim();
  if (url && key) {
    try {
      await createClient(url, key).from('polymarket_claim_log').insert({ message });
    } catch (err) {
      console.error('Could not write to Supabase:', err);
    }
  }
}

const DATA_API_BASE = 'https://data-api.polymarket.com';
const PARENT_COLLECTION_NULL = '0x' + '0'.repeat(64);
const INDEX_SETS_BINARY = [1, 2]; // Yes | No



/** Ethereum address: 0x + 40 hex chars (20 bytes). Data API requires this for the user param. */
function isValidWalletAddress(s: string): boolean {
  const t = s?.trim();
  return !!t && /^0x[a-fA-F0-9]{40}$/.test(t);
}

function getConditionIdsFromEnvOrArgs(): string[] {
  const envIds = process.env.CONDITION_IDS?.trim();
  if (envIds) return envIds.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
  const args = process.argv.slice(2);
  return args.filter((a) => /^0x[a-fA-F0-9]{64}$/.test(a) || /^[a-fA-F0-9]{64}$/.test(a));
}

type PositionRow = { conditionId?: string; redeemable?: boolean; proxyWallet?: string };

/** Fetch positions from Data API (optionally with redeemable filter). */
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

type PositionWithProxy = { conditionId: string; proxyWallet: string };

/** Fetch redeemable positions with proxyWallet (actual holder). */
async function fetchRedeemablePositionsWithProxy(user: string): Promise<PositionWithProxy[]> {
  let rows: PositionRow[];
  const withFilter = await fetchPositions(user, true);
  if (withFilter.length > 0) {
    rows = withFilter;
  } else {
    const all = await fetchPositions(user, false);
    const redeemable = all.filter((r) => r.redeemable);
    if (redeemable.length > 0) {
      console.log(`Found ${redeemable.length} redeemable position(s) via fallback (all positions).`);
    }
    rows = redeemable;
  }
  const out: PositionWithProxy[] = [];
  for (const row of rows) {
    if (!row.redeemable) continue;
    const c = row.conditionId?.trim();
    if (!c) continue;
    const conditionId = c.startsWith('0x') ? c : `0x${c}`;
    if (!/^0x[a-fA-F0-9]{64}$/.test(conditionId)) continue;
    const proxy = row.proxyWallet?.trim();
    const holder = proxy && isValidWalletAddress(proxy) ? proxy : user;
    out.push({ conditionId, proxyWallet: holder });
  }
  return out;
}

/** Fetch redeemable condition IDs: try API redeemable filter first, then fallback (legacy, no proxyWallet). */
async function fetchRedeemableConditionIds(funder: string): Promise<string[]> {
  const withProxy = await fetchRedeemablePositionsWithProxy(funder);
  return withProxy.map((p) => p.conditionId);
}

/** Encode CTF.redeemPositions(collateralToken, parentCollectionId, conditionId, indexSets). */
function encodeRedeemPositions(conditionId: string): string {
  const iface = new ethers.Interface(CTF_ABI as unknown as string[]);
  return iface.encodeFunctionData('redeemPositions', [
    USDC_POLYGON,
    PARENT_COLLECTION_NULL,
    conditionId,
    INDEX_SETS_BINARY,
  ]);
}

type FlowResult = { needMorePol: boolean; redeemSuccess: number; redeemFail: number; transferOk: boolean };

async function runEoaFlow(conditionIds: string[], rpcUrl: string, privateKey: string): Promise<FlowResult> {
  const result: FlowResult = { needMorePol: false, redeemSuccess: 0, redeemFail: 0, transferOk: true };
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`, provider);
  const signerAddress = wallet.address;
  console.log('EOA flow: signing with', signerAddress);
  const balanceWei = await provider.getBalance(signerAddress);
  if (balanceWei === 0n) {
    result.needMorePol = true;
    throw new Error(`Wallet ${signerAddress} has 0 POL on Polygon. Send POL for gas.`);
  }
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
      result.redeemSuccess++;
      console.log('Redeemed:', conditionId);
    } catch (e) {
      if (isInsufficientGasError(e)) result.needMorePol = true;
      result.redeemFail++;
      console.error('Redeem failed for', conditionId, e);
    }
  }
  return result;
}

async function main() {
  await applyProxy();

  const rpcUrl = process.env.POLYGON_RPC_URL?.trim() || 'https://polygon-mainnet.g.alchemy.com/v2/J6wjUKfJUdYzPD5QNDd-i';
  const eoaFunder = process.env.POLYMARKET_FUNDER?.trim();
  const eoaKey = process.env.POLYMARKET_PRIVATE_KEY?.trim();

  let conditionIds = getConditionIdsFromEnvOrArgs();

  // Discovery: POLYMARKET_FUNDER and optionally POLYMARKET_PROXY_WALLET (same as B123). EOA only.
  const discoveryAddresses: string[] = [];
  if (eoaFunder && isValidWalletAddress(eoaFunder)) {
    discoveryAddresses.push(eoaFunder);
  }
  const proxyWalletEnv = process.env.POLYMARKET_PROXY_WALLET?.trim();
  if (proxyWalletEnv && isValidWalletAddress(proxyWalletEnv) && !discoveryAddresses.some((a) => a.toLowerCase() === proxyWalletEnv.toLowerCase())) {
    discoveryAddresses.push(proxyWalletEnv);
  }

  const eoaIds: string[] = [];
  const signerFromEoa = eoaKey ? new ethers.Wallet(eoaKey.startsWith('0x') ? eoaKey : `0x${eoaKey}`).address : null;

  if (conditionIds.length === 0 && discoveryAddresses.length > 0) {
    try {
      const seenConditionIds = new Set<string>();
      for (const addr of discoveryAddresses) {
        console.log('Discovering redeemable positions for', addr, '...');
        const positions = await fetchRedeemablePositionsWithProxy(addr);
        if (positions.length > 0) console.log('Found', positions.length, 'for', addr);
        for (const { conditionId, proxyWallet } of positions) {
          if (seenConditionIds.has(conditionId)) continue;
          seenConditionIds.add(conditionId);
          const holder = proxyWallet.toLowerCase();
          // EOA flow: positions for our funder or held by our signer (same as B123).
          if (eoaFunder && holder === eoaFunder.toLowerCase()) {
            eoaIds.push(conditionId);
          } else if (signerFromEoa && holder === signerFromEoa.toLowerCase()) {
            eoaIds.push(conditionId);
          } else if (discoveryAddresses.some((a) => a.toLowerCase() === holder)) {
            eoaIds.push(conditionId);
          }
        }
      }
      if (eoaIds.length > 0) console.log('Total redeemable:', eoaIds.length);
    } catch (e) {
      console.error('Discovery failed:', e);
      process.exit(1);
    }
  }

  if (conditionIds.length === 0 && eoaIds.length === 0) {
    console.log('No condition IDs to redeem (no args, no CONDITION_IDS, and no redeemable positions from Data API).');
    await writeClaimLog('ALL ITEMS CLAIMED');
    process.exit(0);
  }

  if (conditionIds.length > 0 && eoaIds.length === 0) {
    conditionIds.forEach((id) => eoaIds.push(id));
  }

  let flowResult: FlowResult = { needMorePol: false, redeemSuccess: 0, redeemFail: 0, transferOk: false };

  if (eoaIds.length > 0 && eoaKey) {
    console.log('EOA flow:', eoaIds.length, 'position(s)');
    const eoaResult = await runEoaFlow(eoaIds, rpcUrl, eoaKey);
    flowResult.redeemSuccess += eoaResult.redeemSuccess;
    flowResult.redeemFail += eoaResult.redeemFail;
    flowResult.needMorePol = flowResult.needMorePol || eoaResult.needMorePol;
    flowResult.transferOk = eoaResult.transferOk;
  } else if (eoaIds.length > 0 && !eoaKey) {
    console.warn('Skipping', eoaIds.length, 'position(s): POLYMARKET_PRIVATE_KEY not set.');
    flowResult.redeemFail += eoaIds.length;
  }

  reportAndLog(flowResult);
}

function reportAndLog(flowResult: FlowResult): void {
  const message: ClaimResult =
    flowResult.needMorePol
      ? 'NEED MORE POL'
      : flowResult.redeemFail === 0 && flowResult.transferOk
        ? 'ALL ITEMS CLAIMED'
        : 'CLAIM INCOMPLETE';

  console.log('\n---');
  if (message === 'NEED MORE POL') {
    console.log('NEED MORE POL');
  } else if (message === 'CLAIM INCOMPLETE') {
    const parts: string[] = [];
    if (flowResult.redeemFail > 0) {
      parts.push(`${flowResult.redeemFail} redeem(s) failed`);
    }
    if (!flowResult.transferOk) {
      parts.push('transfer failed');
    }
    const unclaimed = flowResult.redeemFail > 0 ? `${flowResult.redeemFail} UNCLAIMED – ` : '';
    console.log(`${unclaimed}${parts.join(', ')}. TRY AGAIN.`);
  } else {
    console.log(message);
  }
  writeClaimLog(message).catch((e) => console.error('Log write failed:', e));
}

main().catch(async (e) => {
  const errMsg = e instanceof Error ? e.message : String(e);
  const short = errMsg.length > 80 ? errMsg.slice(0, 77) + '...' : errMsg;
  console.error(short);
  console.log('\n---\nCLAIM INCOMPLETE (error). TRY AGAIN.');
  await writeClaimLog('CLAIM INCOMPLETE').catch(() => {});
  process.exit(1);
});
