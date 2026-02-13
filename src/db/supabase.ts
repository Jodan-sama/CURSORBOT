/**
 * Supabase client and helpers for bot config, positions log, spread thresholds, and B3 blocks.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { BOT_SPREAD_THRESHOLD_PCT, type SpreadThresholdsMatrix } from '../kalshi/spread.js';

export type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP';
export type BotId = 'B1' | 'B2' | 'B3';
export type Venue = 'kalshi' | 'polymarket';

export interface BotConfigRow {
  id: string;
  emergency_off: boolean;
  position_size_kalshi: number;
  position_size_polymarket: number;
  b3_block_min: number;
  b2_high_spread_threshold_pct: number;
  b2_high_spread_block_min: number;
  updated_at: string;
}

export interface PositionRow {
  id: string;
  entered_at: string;
  bot: BotId;
  asset: Asset;
  venue: Venue;
  strike_spread_pct: number;
  position_size: number;
  ticker_or_slug: string | null;
  order_id: string | null;
  raw: Record<string, unknown> | null;
}

export interface AssetBlockRow {
  asset: Asset;
  block_until: string;
  created_at: string;
}

function getSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY required');
  return createClient(url, key);
}

let client: SupabaseClient | null = null;

export function getDb(): SupabaseClient {
  if (!client) client = getSupabase();
  return client;
}

/** Read emergency off and default position sizes. */
export async function getBotConfig(): Promise<BotConfigRow> {
  const { data, error } = await getDb()
    .from('bot_config')
    .select('*')
    .eq('id', 'default')
    .single();
  if (error) throw new Error(`bot_config: ${error.message}`);
  if (!data) throw new Error('bot_config: no row');
  return data as BotConfigRow;
}

/** Check if trading is paused. */
export async function isEmergencyOff(): Promise<boolean> {
  const c = await getBotConfig();
  return c.emergency_off;
}

/** B3 block duration (min), B2 spread threshold (%), B2 high-spread→B1 delay (min). */
export async function getBotDelays(): Promise<{
  b3BlockMin: number;
  b2HighSpreadThresholdPct: number;
  b2HighSpreadBlockMin: number;
}> {
  const c = await getBotConfig();
  return {
    b3BlockMin: Number(c.b3_block_min) || 60,
    b2HighSpreadThresholdPct: Number(c.b2_high_spread_threshold_pct) || 0.55,
    b2HighSpreadBlockMin: Number(c.b2_high_spread_block_min) || 15,
  };
}

/** Get position size for a venue (with optional per-bot/asset override). */
export async function getPositionSize(
  venue: Venue,
  bot?: BotId,
  asset?: Asset
): Promise<number> {
  const config = await getBotConfig();
  const defaultSize =
    venue === 'kalshi' ? config.position_size_kalshi : config.position_size_polymarket;
  if (!bot || !asset) return defaultSize;
  const { data } = await getDb()
    .from('bot_position_sizes')
    .select(venue === 'kalshi' ? 'size_kalshi' : 'size_polymarket')
    .eq('bot', bot)
    .eq('asset', asset)
    .maybeSingle();
  const override = data as { size_kalshi?: number; size_polymarket?: number } | null;
  const val = venue === 'kalshi' ? override?.size_kalshi : override?.size_polymarket;
  return val != null ? val : defaultSize;
}

/** Log a new position. */
export async function logPosition(entry: {
  bot: BotId;
  asset: Asset;
  venue: Venue;
  strike_spread_pct: number;
  position_size: number;
  ticker_or_slug?: string;
  order_id?: string;
  raw?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await getDb().from('positions').insert({
    bot: entry.bot,
    asset: entry.asset,
    venue: entry.venue,
    strike_spread_pct: entry.strike_spread_pct,
    position_size: entry.position_size,
    ticker_or_slug: entry.ticker_or_slug ?? null,
    order_id: entry.order_id ?? null,
    raw: entry.raw ?? null,
  });
  if (error) throw new Error(`logPosition: ${error.message}`);
}

/** Set block for asset (B3 filled → block B1/B2). block_until is when the block expires. */
export async function setAssetBlock(asset: Asset, blockUntil: Date): Promise<void> {
  const { error } = await getDb()
    .from('asset_blocks')
    .upsert({ asset, block_until: blockUntil.toISOString() }, { onConflict: 'asset' });
  if (error) throw new Error(`setAssetBlock: ${error.message}`);
}

/** Spread thresholds (pct) per bot per asset. Merges DB with defaults. */
export async function getSpreadThresholds(): Promise<SpreadThresholdsMatrix> {
  const { data, error } = await getDb().from('spread_thresholds').select('bot, asset, threshold_pct');
  if (error) return BOT_SPREAD_THRESHOLD_PCT;
  const matrix: SpreadThresholdsMatrix = {
    B1: { ...BOT_SPREAD_THRESHOLD_PCT.B1 },
    B2: { ...BOT_SPREAD_THRESHOLD_PCT.B2 },
    B3: { ...BOT_SPREAD_THRESHOLD_PCT.B3 },
  };
  for (const row of data as { bot: BotId; asset: Asset; threshold_pct: number }[]) {
    matrix[row.bot][row.asset] = Number(row.threshold_pct);
  }
  return matrix;
}

/** True if B1 already placed an order for this asset in the current 15m window (persists across restarts). */
export async function hasB1PositionThisWindow(asset: Asset, windowStartMs: number): Promise<boolean> {
  return hasBotPositionThisWindow('B1', asset, windowStartMs);
}

/** True if this bot already placed any order (Kalshi or Poly) for this asset in the current 15m window. Persists across restarts. */
export async function hasBotPositionThisWindow(bot: BotId, asset: Asset, windowStartMs: number): Promise<boolean> {
  const windowStart = new Date(windowStartMs).toISOString();
  const { data, error } = await getDb()
    .from('positions')
    .select('id')
    .eq('bot', bot)
    .eq('asset', asset)
    .gte('entered_at', windowStart)
    .limit(1)
    .maybeSingle();
  if (error) return false; // on DB error, allow placement (don't block on bad query)
  return data != null;
}

/** True if at least one Kalshi position was logged in the last N hours. */
export async function hasKalshiPositionInLastHours(hours: number): Promise<boolean> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const { data, error } = await getDb()
    .from('positions')
    .select('id')
    .eq('venue', 'kalshi')
    .gte('entered_at', since)
    .limit(1)
    .maybeSingle();
  if (error) return true; // on DB error, assume we have activity (don't restart)
  return data != null;
}

/** True if this asset is currently blocked (B3 filled recently). */
export async function isAssetBlocked(asset: Asset): Promise<boolean> {
  const now = new Date().toISOString();
  const { data, error } = await getDb()
    .from('asset_blocks')
    .select('asset')
    .eq('asset', asset)
    .gt('block_until', now)
    .maybeSingle();
  if (error) throw new Error(`isAssetBlocked: ${error.message}`);
  return data != null;
}

/** Append B4 paper trader event to Supabase (for dashboard). Does not throw. */
export async function logB4Paper(entry: {
  window_unix: number;
  asset: string;
  event: string;
  direction: string | null;
  price: number | null;
}): Promise<void> {
  try {
    await getDb().from('b4_paper_log').insert({
      window_unix: entry.window_unix,
      asset: entry.asset,
      event: entry.event,
      direction: entry.direction ?? null,
      price: entry.price ?? null,
    });
  } catch (e) {
    console.error('[logB4Paper] failed:', e);
  }
}

/** Log when Polymarket order was skipped (for dashboard visibility). Does not throw. */
export async function logPolySkip(entry: {
  bot: BotId;
  asset: Asset;
  reason: string;
  kalshiPlaced: boolean;
}): Promise<void> {
  try {
    await getDb().from('poly_skip_log').insert({
      bot: entry.bot,
      asset: entry.asset,
      reason: entry.reason,
      kalshi_placed: entry.kalshiPlaced,
    });
  } catch (e) {
    console.error('[logPolySkip] failed:', e);
  }
}

/** Log an error to Supabase (and optionally console). Does not throw. */
export async function logError(
  err: unknown,
  context?: Record<string, unknown>
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack ?? null : null;
  try {
    await getDb().from('error_log').insert({
      message,
      context: context ?? null,
      stack,
    });
  } catch (e) {
    console.error('[logError] failed to write to Supabase:', e);
  }
  console.error('[error]', message, context ?? '', stack ?? '');
}
