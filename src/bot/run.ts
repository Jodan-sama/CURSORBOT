/**
 * Entry point for the long-running bot. Loads env and starts the loop.
 */
import 'dotenv/config';
import { startBotLoop } from './runner.js';

console.log('Cursorbot starting (B1/B2/B3, Kalshi + Polymarket)');
startBotLoop();
