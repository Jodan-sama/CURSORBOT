/**
 * Redeem resolved Polymarket positions (CTF) on Polygon.
 * Uses POLYMARKET_PRIVATE_KEY, POLYMARKET_FUNDER, and POLYGON_RPC_URL from .env.
 *
 * When POLYMARKET_SAFE_ADDRESS is set (e.g. PolyGun Polymarket Wallet), redeems via the Safe
 * and transfers claimed USDC to POLYGON_WALLET. Otherwise redeems from the EOA (legacy).
 *
 * Auto-discovery: with no args and no CONDITION_IDS, fetches redeemable positions
 * from Polymarket Data API (user=POLYMARKET_FUNDER) and redeems each conditionId.
 *
 * Usage:
 *   node dist/scripts/claim-polymarket.js [conditionId1] [conditionId2] ...
 *   Or set CONDITION_IDS=id1,id2 in .env. Or run with no args for auto-discovery.
 *
 * Runs every 5 min at :02, :07, :12, :17, :22, :27, :32, :37, :42, :47, :52, :57 (systemd timer on D2/D3; persists across reboot).
 *
 * Logs: date, time, and status (ALL ITEMS CLAIMED | NEED MORE POL | CLAIM INCOMPLETE) to
 *   logs/claim-polymarket.log and Supabase polymarket_claim_log.
 */
import 'dotenv/config';
import { mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';
import Safe from '@safe-global/protocol-kit';
import { MetaTransactionData, OperationType } from '@safe-global/types-kit';
import { CTF_ADDRESS, USDC_POLYGON, CTF_ABI } from '../polymarket/ctf-constants.js';

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

/** PolyGun Polymarket Wallet (Gnosis Safe) – holds positions. Set POLYMARKET_SAFE_ADDRESS to use Safe flow. */
const DEFAULT_POLYGON_SAFE = '0xBDD5AD35435bAb6b3AdF6A8E7e639D0393263932';
/** PolyGun Polygon wallet (POL, USDC, USDC.e) – claimed USDC is sent here when using Safe. */
const DEFAULT_POLYGON_WALLET = '0x6370422C2DA0cb4b0fE095DDC1dc97d87Cd5223b';

const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
] as const;

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

/** Encode ERC20 transfer(to, amount). */
function encodeTransfer(to: string, amount: bigint): string {
  const iface = new ethers.Interface(ERC20_ABI as unknown as string[]);
  return iface.encodeFunctionData('transfer', [to, amount]);
}

type FlowResult = { needMorePol: boolean; redeemSuccess: number; redeemFail: number; transferOk: boolean };

/**
 * @param transferDestination If set, transfer Safe's USDC here after redeeming. If null, leave USDC in Safe
 * (e.g. polymarket proxy – keep funds available on Polymarket).
 */
async function runSafeFlow(
  conditionIds: string[],
  rpcUrl: string,
  privateKey: string,
  safeAddress: string,
  transferDestination: string | null
): Promise<FlowResult> {
  const result: FlowResult = { needMorePol: false, redeemSuccess: 0, redeemFail: 0, transferOk: false };
  const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const protocolKit = await (Safe as any).init({
    provider: rpcUrl,
    signer: pk,
    safeAddress,
  });

  const signerAddress = await protocolKit.getSafeProvider().getSignerAddress();
  if (!signerAddress) {
    throw new Error('Safe init: no signer address. POLYMARKET_PRIVATE_KEY must be an owner of the Safe.');
  }
  const destMsg = transferDestination ? `USDC → ${transferDestination}` : 'USDC stays in Safe (Polymarket)';
  console.log('Safe flow: Safe', safeAddress, '| signer (owner)', signerAddress, '|', destMsg);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(pk, provider);
  const balanceWei = await provider.getBalance(wallet.address);
  if (balanceWei === 0n) {
    result.needMorePol = true;
    throw new Error(`Signer ${wallet.address} has 0 POL on Polygon. Send POL to this address for gas.`);
  }

  for (const rawId of conditionIds) {
    const conditionId = rawId.startsWith('0x') ? rawId : `0x${rawId}`;
    if (conditionId.length !== 66) {
      console.warn('Skipping invalid conditionId:', rawId);
      continue;
    }
    try {
      const data = encodeRedeemPositions(conditionId);
      const safeTransactionData: MetaTransactionData = {
        to: CTF_ADDRESS,
        value: '0',
        data,
        operation: OperationType.Call,
      };
      let safeTransaction = await protocolKit.createTransaction({
        transactions: [safeTransactionData],
      });
      safeTransaction = await protocolKit.signTransaction(safeTransaction);
      const txResult = await protocolKit.executeTransaction(safeTransaction);
      console.log('Redeem tx:', conditionId, txResult.hash);
      const receipt = await provider.getTransactionReceipt(txResult.hash);
      if (receipt && receipt.status === 0) {
        console.error('Redeem tx failed:', conditionId);
        result.redeemFail++;
        continue;
      }
      result.redeemSuccess++;
      console.log('Redeemed:', conditionId);
    } catch (e) {
      if (isInsufficientGasError(e)) result.needMorePol = true;
      result.redeemFail++;
      console.error('Redeem failed for', conditionId, e);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  await new Promise((r) => setTimeout(r, 3000));

  if (!transferDestination) {
    result.transferOk = true;
    console.log('USDC left in Safe (Polymarket proxy – ready to trade).');
    return result;
  }

  const usdc = new ethers.Contract(USDC_POLYGON, ERC20_ABI, provider);
  const balance = await usdc.balanceOf(safeAddress);
  if (balance === 0n) {
    console.log('No USDC balance in Safe to transfer.');
    return result;
  }
  console.log('Transferring', ethers.formatUnits(balance, 6), 'USDC to', transferDestination);

  try {
    const freshKit = await (Safe as any).init({
      provider: rpcUrl,
      signer: pk,
      safeAddress,
    });
    const transferData: MetaTransactionData = {
      to: USDC_POLYGON,
      value: '0',
      data: encodeTransfer(transferDestination, balance),
      operation: OperationType.Call,
    };
    let transferTx = await freshKit.createTransaction({
      transactions: [transferData],
    });
    transferTx = await freshKit.signTransaction(transferTx);
    const transferResult = await freshKit.executeTransaction(transferTx);
    console.log('Transfer tx:', transferResult.hash);
    const transferReceipt = await provider.getTransactionReceipt(transferResult.hash);
    if (transferReceipt && transferReceipt.status === 0) {
      console.error('Transfer tx failed.');
      return result;
    }
    result.transferOk = true;
    console.log('USDC transferred to', transferDestination);
  } catch (e) {
    if (isInsufficientGasError(e)) result.needMorePol = true;
    console.error('Transfer failed:', e);
  }
  return result;
}

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
  const rpcUrl = process.env.POLYGON_RPC_URL?.trim() || 'https://polygon-mainnet.g.alchemy.com/v2/J6wjUKfJUdYzPD5QNDd-i';
  const polygonWallet =
    process.env.POLYGON_WALLET?.trim() ||
    DEFAULT_POLYGON_WALLET;

  // EOA (main Polymarket wallet, e.g. 0xbafbed80...)
  const eoaFunder = process.env.POLYMARKET_FUNDER?.trim();
  const eoaKey = process.env.POLYMARKET_PRIVATE_KEY?.trim();

  // PolyGun Safe (0xbdd5ad...)
  const safeFunder =
    process.env.POLYGUN_CLAIM_FUNDER?.trim() ||
    process.env.POLYMARKET_SAFE_ADDRESS?.trim();
  const safeKey =
    process.env.POLYGUN_CLAIM_PRIVATE_KEY?.trim() ||
    process.env.POLYMARKET_PRIVATE_KEY?.trim();

  let conditionIds = getConditionIdsFromEnvOrArgs();

  // Build discovery list: EOA (0xbafbed80...), Safe (0xbdd5ad...), proxy
  const discoveryAddresses: { addr: string; isSafe: boolean }[] = [];
  const safeNorm = safeFunder?.toLowerCase();
  if (eoaFunder && isValidWalletAddress(eoaFunder) && eoaFunder.toLowerCase() !== safeNorm) {
    discoveryAddresses.push({ addr: eoaFunder, isSafe: false });
  }
  if (safeFunder && isValidWalletAddress(safeFunder)) {
    discoveryAddresses.push({ addr: safeFunder, isSafe: true });
  }
  const proxy = process.env.POLYMARKET_PROXY_WALLET?.trim();
  if (proxy && isValidWalletAddress(proxy) && !discoveryAddresses.some((d) => d.addr.toLowerCase() === proxy.toLowerCase())) {
    discoveryAddresses.push({ addr: proxy, isSafe: false });
  }

  // Positions grouped by holder: EOA (signer) vs Safe (proxyWallet). Polymarket uses Gnosis Safe proxies;
  // positions live in the Safe, not the signer. We must redeem via Safe (execTransaction), not EOA directly.
  const eoaIds: string[] = [];
  const safePositionsByAddress = new Map<string, string[]>();

  const signerFromEoa = eoaKey ? new ethers.Wallet(eoaKey.startsWith('0x') ? eoaKey : `0x${eoaKey}`).address : null;

  if (conditionIds.length === 0 && discoveryAddresses.length > 0) {
    try {
      const seenConditionIds = new Set<string>();
      for (const { addr } of discoveryAddresses) {
        console.log('Discovering redeemable positions for', addr, '...');
        const positions = await fetchRedeemablePositionsWithProxy(addr);
        if (positions.length > 0) console.log('Found', positions.length, 'for', addr);
        for (const { conditionId, proxyWallet } of positions) {
          if (seenConditionIds.has(conditionId)) continue;
          seenConditionIds.add(conditionId);
          const holder = proxyWallet.toLowerCase();
          if (signerFromEoa && holder === signerFromEoa.toLowerCase()) {
            eoaIds.push(conditionId);
          } else {
            const list = safePositionsByAddress.get(holder) ?? [];
            list.push(conditionId);
            safePositionsByAddress.set(holder, list);
          }
        }
      }
      const total = eoaIds.length + [...safePositionsByAddress.values()].flat().length;
      if (total > 0) console.log('Total redeemable:', total);
    } catch (e) {
      console.error('Discovery failed:', e);
      process.exit(1);
    }
  }

  if (conditionIds.length === 0 && eoaIds.length === 0 && safePositionsByAddress.size === 0) {
    console.log('No condition IDs to redeem (no args, no CONDITION_IDS, and no redeemable positions from Data API).');
    await writeClaimLog('ALL ITEMS CLAIMED');
    process.exit(0);
  }

  // Explicit CONDITION_IDS/args: no proxyWallet from API. Use Safe if safeFunder set, or if eoaFunder is a proxy (≠ signer).
  if (eoaIds.length === 0 && safePositionsByAddress.size === 0 && conditionIds.length > 0) {
    const eoaIsProxy = eoaFunder && signerFromEoa && eoaFunder.toLowerCase() !== signerFromEoa.toLowerCase();
    if (safeFunder && isValidWalletAddress(safeFunder)) {
      safePositionsByAddress.set(safeFunder.toLowerCase(), [...conditionIds]);
    } else if (eoaIsProxy && isValidWalletAddress(eoaFunder!)) {
      safePositionsByAddress.set(eoaFunder!.toLowerCase(), [...conditionIds]);
    } else {
      conditionIds.forEach((id) => eoaIds.push(id));
    }
  }

  let flowResult: FlowResult = { needMorePol: false, redeemSuccess: 0, redeemFail: 0, transferOk: false };

  if (eoaIds.length > 0 && eoaKey) {
    console.log('EOA flow:', eoaIds.length, 'position(s) (signer holds directly)');
    const eoaResult = await runEoaFlow(eoaIds, rpcUrl, eoaKey);
    flowResult.redeemSuccess += eoaResult.redeemSuccess;
    flowResult.redeemFail += eoaResult.redeemFail;
    flowResult.needMorePol = flowResult.needMorePol || eoaResult.needMorePol;
    flowResult.transferOk = eoaResult.transferOk;
  } else if (eoaIds.length > 0 && !eoaKey) {
    console.warn('Skipping', eoaIds.length, 'EOA position(s): POLYMARKET_PRIVATE_KEY not set.');
    flowResult.redeemFail += eoaIds.length;
  }

  for (const [safeAddr, ids] of safePositionsByAddress) {
    if (ids.length === 0) continue;
    const key = (safeAddr === safeFunder?.toLowerCase() ? safeKey : eoaKey) ?? eoaKey;
    if (!key) {
      console.error('No private key for Safe', safeAddr, '- POLYMARKET_PRIVATE_KEY or POLYGUN_CLAIM_PRIVATE_KEY required.');
      flowResult.redeemFail += ids.length;
      continue;
    }
    const isPolygunSafe = safeAddr === safeFunder?.toLowerCase();
    const transferDest = isPolygunSafe && isValidWalletAddress(polygonWallet) ? polygonWallet : null;
    if (isPolygunSafe && !isValidWalletAddress(polygonWallet)) {
      console.error('POLYGON_WALLET must be valid. USDC from PolyGun Safe is sent there.');
      flowResult.redeemFail += ids.length;
      continue;
    }
    if (eoaIds.length > 0 || flowResult.redeemSuccess > 0 || flowResult.redeemFail > 0) {
      await new Promise((r) => setTimeout(r, 3000));
    }
    const safeAddrNorm = '0x' + safeAddr.replace(/^0x/, '');
    console.log('Safe flow:', ids.length, 'position(s) from Safe', safeAddrNorm);
    const safeResult = await runSafeFlow(ids, rpcUrl, key, safeAddrNorm, transferDest);
    flowResult.redeemSuccess += safeResult.redeemSuccess;
    flowResult.redeemFail += safeResult.redeemFail;
    flowResult.needMorePol = flowResult.needMorePol || safeResult.needMorePol;
    flowResult.transferOk = flowResult.transferOk || safeResult.transferOk;
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
