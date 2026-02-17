import 'dotenv/config';
import { startB123cRunner } from './b123c-runner.js';

console.log('[B123c] Starting B1c/B2c/B3c Chainlink-only runner');
startB123cRunner().catch((err) => {
  console.error('[B123c] Fatal:', err);
  process.exit(1);
});
