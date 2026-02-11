/**
 * Transfer USDC from a Safe (e.g. PolyGun) to POLYGON_WALLET.
 * Uses POLYGUN_CLAIM_FUNDER/POLYMARKET_SAFE_ADDRESS, POLYGON_WALLET, and POLYGUN_CLAIM_PRIVATE_KEY from .env.
 *
 * Usage: npm run transfer-safe-usdc
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import Safe from '@safe-global/protocol-kit';
import { MetaTransactionData, OperationType } from '@safe-global/types-kit';

const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const DEFAULT_SAFE = '0xBDD5AD35435bAb6b3AdF6A8E7e639D0393263932';
const DEFAULT_WALLET = '0x6370422C2DA0cb4b0fE095DDC1dc97d87Cd5223b';

const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
] as const;

function encodeTransfer(to: string, amount: bigint): string {
  const iface = new ethers.Interface(ERC20_ABI as unknown as string[]);
  return iface.encodeFunctionData('transfer', [to, amount]);
}

async function main() {
  const rpcUrl = process.env.POLYGON_RPC_URL?.trim() || 'https://polygon-mainnet.g.alchemy.com/v2/J6wjUKfJUdYzPD5QNDd-i';
  const safeAddress =
    process.env.POLYGUN_CLAIM_FUNDER?.trim() ||
    process.env.POLYGUN_CLAIM_SAFE_ADDRESS?.trim() ||
    process.env.POLYMARKET_SAFE_ADDRESS?.trim() ||
    DEFAULT_SAFE;
  const destination =
    process.env.POLYGON_WALLET?.trim() ||
    DEFAULT_WALLET;
  const privateKey =
    process.env.POLYGUN_CLAIM_PRIVATE_KEY?.trim() ||
    process.env.POLYMARKET_PRIVATE_KEY?.trim();

  if (!privateKey) {
    console.error('POLYGUN_CLAIM_PRIVATE_KEY or POLYMARKET_PRIVATE_KEY required.');
    process.exit(1);
  }

  const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const usdc = new ethers.Contract(USDC_POLYGON, ERC20_ABI, provider);
  const balance = await usdc.balanceOf(safeAddress);

  if (balance === 0n) {
    console.log('Safe', safeAddress, 'has 0 USDC. Nothing to transfer.');
    return;
  }

  console.log('Safe:', safeAddress);
  console.log('USDC balance:', ethers.formatUnits(balance, 6));
  console.log('Transferring to:', destination);

  const protocolKit = await (Safe as any).init({
    provider: rpcUrl,
    signer: pk,
    safeAddress,
  });

  const transferData: MetaTransactionData = {
    to: USDC_POLYGON,
    value: '0',
    data: encodeTransfer(destination, balance),
    operation: OperationType.Call,
  };

  let tx = await protocolKit.createTransaction({ transactions: [transferData] });
  tx = await protocolKit.signTransaction(tx);
  const result = await protocolKit.executeTransaction(tx);
  console.log('Transfer tx:', result.hash);

  const receipt = await provider.getTransactionReceipt(result.hash);
  if (receipt && receipt.status === 0) {
    console.error('Transfer tx failed (reverted).');
    process.exit(1);
  }
  console.log('Done. USDC sent to', destination);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
