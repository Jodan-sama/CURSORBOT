/**
 * B5: USDC balance and "highest balance seen" for dynamic sizing.
 * Sizing uses the max balance ever seen so we don't shrink risk while waiting for claims.
 */

import { ethers } from 'ethers';
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

const B5_STATE_DIR = process.env.B5_STATE_DIR || join(process.cwd(), 'b5-state');
const MAX_BALANCE_FILE = join(B5_STATE_DIR, 'max_balance.json');

let inMemoryMaxBalance = 0;

export interface MaxBalanceState {
  maxBalanceUsd: number;
  updatedAt: string;
}

function ensureDir(): void {
  if (!existsSync(B5_STATE_DIR)) {
    mkdirSync(B5_STATE_DIR, { recursive: true });
  }
}

/** Load persisted max balance (from previous runs). */
export function loadMaxBalance(): number {
  try {
    inMemoryMaxBalance = 0;
    if (existsSync(MAX_BALANCE_FILE)) {
      const raw = readFileSync(MAX_BALANCE_FILE, 'utf-8');
      const data = JSON.parse(raw) as MaxBalanceState;
      if (typeof data.maxBalanceUsd === 'number' && data.maxBalanceUsd > 0) {
        inMemoryMaxBalance = data.maxBalanceUsd;
      }
    }
  } catch {
    // ignore
  }
  return inMemoryMaxBalance;
}

/** Persist max balance to disk. */
function saveMaxBalance(value: number): void {
  ensureDir();
  writeFileSync(
    MAX_BALANCE_FILE,
    JSON.stringify({ maxBalanceUsd: value, updatedAt: new Date().toISOString() }, null, 0),
    'utf-8'
  );
}

/** Get current USDC balance for wallet (Polygon). */
export async function getUSDCBalance(walletAddress: string): Promise<number> {
  const rpcUrl = process.env.POLYGON_RPC_URL?.trim() || 'https://polygon-mainnet.g.alchemy.com/v2/J6wjUKfJUdYzPD5QNDd-i';
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const usdc = new ethers.Contract(USDC_POLYGON, ERC20_ABI, provider);
  const raw = await usdc.balanceOf(walletAddress);
  return Number(ethers.formatUnits(raw, 6));
}

/**
 * Update "highest balance seen" from current balance; persist if new max.
 * Call after every balance fetch. Returns the balance and the max-to-use for sizing.
 */
export function updateMaxBalanceSeen(currentBalance: number): number {
  if (currentBalance > inMemoryMaxBalance) {
    inMemoryMaxBalance = currentBalance;
    saveMaxBalance(inMemoryMaxBalance);
  }
  return inMemoryMaxBalance;
}

/** Get the value to use for dynamic sizing (max of current and persisted max). */
export function getMaxBalanceForSizing(walletAddress: string): Promise<{ balance: number; maxForSizing: number }> {
  return getUSDCBalance(walletAddress).then((balance) => {
    const maxForSizing = updateMaxBalanceSeen(balance);
    return { balance, maxForSizing };
  });
}
