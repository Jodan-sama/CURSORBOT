/**
 * Entry point for the long-running bot. Loads env and starts the loop.
 */
import 'dotenv/config';
import { startBotLoop } from './runner.js';

function isPolymarketEnabled(): boolean {
  const v = process.env.ENABLE_POLYMARKET?.trim().toLowerCase();
  return v === 'true' || v === '1';
}

const venue = isPolymarketEnabled() ? 'Kalshi + Polymarket' : 'Kalshi only';
console.log(`Cursorbot starting (B1/B2/B3, ${venue})`);
startBotLoop();
