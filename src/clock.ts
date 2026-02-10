/**
 * 15-minute window clock (UTC). Used to decide which market we're in and bot timing.
 */

import type { Asset } from './kalshi/ticker.js';
import { POLY_15M_SLUG_PREFIX } from './polymarket/gamma.js';

const WINDOW_MS = 15 * 60 * 1000;

/** Current 15m window end (UTC). E.g. if now is 14:37, returns 14:45. */
export function getCurrentWindowEnd(now: Date = new Date()): Date {
  const ms = now.getTime();
  const remainder = ms % WINDOW_MS;
  const windowEnd = new Date(ms - remainder + WINDOW_MS);
  return windowEnd;
}

/** Unix seconds for the current window end (for Polymarket slug). */
export function getCurrentWindowEndUnix(now: Date = new Date()): number {
  return Math.floor(getCurrentWindowEnd(now).getTime() / 1000);
}

/** Milliseconds remaining until the current window ends. */
export function msUntilWindowEnd(now: Date = new Date()): number {
  return getCurrentWindowEnd(now).getTime() - now.getTime();
}

/** Minutes left in the current 15m window (0–15). */
export function minutesLeftInWindow(now: Date = new Date()): number {
  const end = getCurrentWindowEnd(now).getTime();
  const left = (end - now.getTime()) / (60 * 1000);
  return Math.max(0, left);
}

/** Polymarket slug for the current 15m window for the given asset. */
export function getCurrentPolySlug(asset: Asset, now: Date = new Date()): string {
  const prefix = POLY_15M_SLUG_PREFIX[asset];
  const unix = getCurrentWindowEndUnix(now);
  return `${prefix}${unix}`;
}

// --- Bot timing (from your rules) ---

/** B1: last 2.5 min of window → true when minutesLeft in (0, 2.5]. */
export function isB1Window(minutesLeft: number): boolean {
  return minutesLeft > 0 && minutesLeft <= 2.5;
}

/** B2: last 5 min → true when minutesLeft in (0, 5]. */
export function isB2Window(minutesLeft: number): boolean {
  return minutesLeft > 0 && minutesLeft <= 5;
}

/** B3: last 8 min → true when minutesLeft in (0, 8]. */
export function isB3Window(minutesLeft: number): boolean {
  return minutesLeft > 0 && minutesLeft <= 8;
}

/** B1: use market order in the final 1 minute. */
export function isB1MarketOrderWindow(minutesLeft: number): boolean {
  return minutesLeft > 0 && minutesLeft <= 1;
}
