/**
 * 5-minute window clock (UTC). Polymarket slug: btc-updown-5m-{unix_start}.
 */

const WINDOW_MS = 5 * 60 * 1000;

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

export function minutesLeftInWindow(now: Date = new Date()): number {
  return msUntilWindowEnd(now) / 60_000;
}

/** Polymarket slug for current 5-min BTC market. */
export function getPolySlug5m(now: Date = new Date()): string {
  return `btc-updown-5m-${getWindowStartUnix(now)}`;
}

/** Returns true if we're in the entry window: 90-150 seconds into the 5-min window. */
export function isEntryWindow(now: Date = new Date()): boolean {
  const sec = secondsIntoWindow(now);
  return sec >= 90 && sec <= 150;
}

/** Returns true if we should start collecting intra-window data (~30s in). */
export function isDataCollectionPhase(now: Date = new Date()): boolean {
  return secondsIntoWindow(now) >= 30;
}

export { WINDOW_MS };
