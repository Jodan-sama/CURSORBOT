/**
 * B4/B5 Paper Trader entry point.
 * Usage: node dist/b4-5m/paper-run.js
 */

import 'dotenv/config';
import { startPaperTrader } from './paper-runner.js';

process.on('unhandledRejection', (reason, promise) => {
  console.error('[PAPER] unhandledRejection', reason, promise);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('[PAPER] uncaughtException', err);
  process.exit(1);
});

console.log('B4/B5 paper trader starting');
startPaperTrader().catch((e) => {
  console.error('[PAPER] startPaperTrader failed:', e);
  process.exit(1);
});
