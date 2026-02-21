/**
 * 5-minute window clock (UTC). B5: ETH, SOL, XRP slugs: {asset}-updown-5m-{unix_start}.
 */

const WINDOW_MS = 5 * 60 * 1000;

export type B5Asset = 'ETH' | 'SOL' | 'XRP';

export const B5_ASSETS: B5Asset[] = ['ETH', 'SOL', 'XRP'];

export function getWindowStart(now: Date = new Date()): Date {
  const ms = now.getTime();
  return new Date(ms - (ms % WINDOW_MS));
}

export function getWindowEnd(now: Date = new Date()): Date {
  return new Date(getWindowStart(now).getTime() + WINDOW_MS);
}

export function getWindowStartUnix(now: Date = new Date()): number {
  return Math.floor(getWindowStart(now).getTime() / 1000);
}

export function msUntilWindowEnd(now: Date = new Date()): number {
  return getWindowEnd(now).getTime() - now.getTime();
}

export function secondsIntoWindow(now: Date = new Date()): number {
  return (now.getTime() - getWindowStart(now).getTime()) / 1000;
}

/** Polymarket slug for current 5-min market for the given asset. */
export function getPolySlug5m(asset: B5Asset, now: Date = new Date()): string {
  const prefix = asset.toLowerCase();
  return `${prefix}-updown-5m-${getWindowStartUnix(now)}`;
}

export { WINDOW_MS };
