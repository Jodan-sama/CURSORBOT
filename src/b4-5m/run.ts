/**
 * B4 5-Minute BTC Bot entry point.
 * Usage: node dist/b4-5m/run.js  (or npx tsx src/b4-5m/run.ts for dev)
 */

import 'dotenv/config';
import { startB4Loop } from './runner.js';

process.on('unhandledRejection', (reason, promise) => {
  console.error('[B4] unhandledRejection', reason, promise);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('[B4] uncaughtException', err);
  process.exit(1);
});

console.log(`B4 5-min BTC bot starting`);
startB4Loop().catch((e) => {
  console.error('[B4] startB4Loop failed:', e);
  process.exit(1);
});
