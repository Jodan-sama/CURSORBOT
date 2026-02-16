/**
 * Entry point for the B4 spread-based 5-minute strategy.
 * Run: node dist/b4-5m/spread-run.js
 */

import 'dotenv/config';
import { startSpreadRunner } from './spread-runner.js';

process.on('unhandledRejection', (err) => {
  console.error('[B4] unhandled rejection:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('[B4] uncaught exception:', err);
  process.exit(1);
});

console.log('B4 spread runner starting');
startSpreadRunner().catch((e) => {
  console.error('[B4] fatal:', e);
  process.exit(1);
});
