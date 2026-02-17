/**
 * Supabase client and helpers for bot config, positions log, spread thresholds, and B3 blocks.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { BOT_SPREAD_THRESHOLD_PCT, type SpreadThresholdsMatrix } from '../kalshi/spread.js';

export type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP';
export type BotId = 'B1' | 'B2' | 'B3' | 'B4' | 'B1c' | 'B2c' | 'B3c';
export type Venue = 'kalshi' | 'polymarket';

export interface BotConfigRow {
  id: string;
  emergency_off: boolean;
  position_size_kalshi: number;
  position_size_polymarket: number;
  b3_block_min: number;
  b2_high_spread_threshold_pct: number;
  b2_high_spread_block_min: number;
  b3_early_high_spread_pct: number;
  b3_early_high_spread_block_min: number;
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

/** Check if trading is paused (B1/B2/B3). */
export async function isEmergencyOff(): Promise<boolean> {
  const c = await getBotConfig();
  return c.emergency_off;
}

/** Check if B4 is paused (uses cooldown_until_ms in b4_state: 1 = off, 0 = running). */
export async function isB4EmergencyOff(): Promise<boolean> {
  try {
    const { data } = await getDb()
      .from('b4_state')
      .select('cooldown_until_ms')
      .eq('id', 'default')
      .maybeSingle();
    return data?.cooldown_until_ms === 1;
  } catch {
    return false;
  }
}

/** Set B4 emergency off/resume (uses cooldown_until_ms in b4_state). */
export async function setB4EmergencyOff(off: boolean): Promise<void> {
  await getDb().from('b4_state').update({
    cooldown_until_ms: off ? 1 : 0,
    updated_at: new Date().toISOString(),
  }).eq('id', 'default');
}

/** B3 block duration (min), B2 spread threshold (%), B2 high-spread→B1 delay (min), B3 early high-spread. */
export async function getBotDelays(): Promise<{
  b3BlockMin: number;
  b2HighSpreadThresholdPct: number;
  b2HighSpreadBlockMin: number;
  b3EarlyHighSpreadPct: number;
  b3EarlyHighSpreadBlockMin: number;
}> {
  const c = await getBotConfig();
  return {
    b3BlockMin: Number(c.b3_block_min) || 60,
    b2HighSpreadThresholdPct: Number(c.b2_high_spread_threshold_pct) || 0.55,
    b2HighSpreadBlockMin: Number(c.b2_high_spread_block_min) || 15,
    b3EarlyHighSpreadPct: Number(c.b3_early_high_spread_pct) ?? 1.8,
    b3EarlyHighSpreadBlockMin: Number(c.b3_early_high_spread_block_min) ?? 15,
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
  for (const row of data as { bot: string; asset: Asset; threshold_pct: number }[]) {
    if (row.bot in matrix) {
      (matrix as Record<string, Record<string, number>>)[row.bot][row.asset] = Number(row.threshold_pct);
    }
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

// ---------------------------------------------------------------------------
// B4 state persistence
// ---------------------------------------------------------------------------

export interface B4TierConfig {
  t1_spread: number;
  t2_spread: number;
  t3_spread: number;
  t2_block_min: number;
  t3_block_min: number;
  position_size: number;
  b123c_position_size: number;
}

export const DEFAULT_B4_CONFIG: B4TierConfig = {
  t1_spread: 0.10,
  t2_spread: 0.21,
  t3_spread: 0.45,
  t2_block_min: 5,
  t3_block_min: 15,
  position_size: 5,
  b123c_position_size: 5,
};

export interface B4StateRow {
  bankroll: number;
  max_bankroll: number;
  consecutive_losses: number;
  cooldown_until_ms: number;
  results_json: B4TierConfig | boolean[];
  daily_start_bankroll: number;
  daily_start_date: string;
  half_kelly_trades_left: number;
  updated_at: string;
}

/** Load B4 risk state from Supabase. Returns null if table doesn't exist or no row. */
export async function loadB4State(): Promise<B4StateRow | null> {
  try {
    const { data, error } = await getDb()
      .from('b4_state')
      .select('*')
      .eq('id', 'default')
      .maybeSingle();
    if (error || !data) return null;
    const row = data as Record<string, unknown>;
    return {
      bankroll: Number(row.bankroll) || 30,
      max_bankroll: Number(row.max_bankroll) || 30,
      consecutive_losses: Number(row.consecutive_losses) || 0,
      cooldown_until_ms: Number(row.cooldown_until_ms) || 0,
      results_json: Array.isArray(row.results_json) ? row.results_json as boolean[] : [],
      daily_start_bankroll: Number(row.daily_start_bankroll) || 30,
      daily_start_date: String(row.daily_start_date ?? ''),
      half_kelly_trades_left: Number(row.half_kelly_trades_left) || 0,
      updated_at: String(row.updated_at ?? ''),
    };
  } catch {
    return null;
  }
}

/** Save B4 risk state to Supabase. Does not throw. */
export async function saveB4State(state: Omit<B4StateRow, 'updated_at'>): Promise<void> {
  try {
    await getDb().from('b4_state').upsert({
      id: 'default',
      bankroll: state.bankroll,
      max_bankroll: state.max_bankroll,
      consecutive_losses: state.consecutive_losses,
      cooldown_until_ms: state.cooldown_until_ms,
      results_json: state.results_json,
      daily_start_bankroll: state.daily_start_bankroll,
      daily_start_date: state.daily_start_date,
      half_kelly_trades_left: state.half_kelly_trades_left,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
  } catch (e) {
    console.error('[saveB4State] failed:', e instanceof Error ? e.message : e);
  }
}

/** Save B4 open position to Supabase (survives restarts). Pass null to clear. */
export async function saveB4OpenPosition(position: Record<string, unknown> | null): Promise<void> {
  try {
    await getDb().from('b4_state').update({
      results_json: position ?? [],
      updated_at: new Date().toISOString(),
    }).eq('id', 'default');
  } catch (e) {
    console.error('[saveB4OpenPosition] failed:', e instanceof Error ? e.message : e);
  }
}

/** Load B4 open position from Supabase. Returns null if none saved or data is invalid. */
export async function loadB4OpenPosition(): Promise<Record<string, unknown> | null> {
  try {
    const { data, error } = await getDb()
      .from('b4_state')
      .select('results_json')
      .eq('id', 'default')
      .maybeSingle();
    if (error || !data) return null;
    const raw = (data as Record<string, unknown>).results_json;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const pos = raw as Record<string, unknown>;
      // Validate required fields to avoid restoring stale/corrupt data
      if (!pos.tokenId || !pos.entryMid || !pos.direction) return null;
      if (typeof pos.entryMid === 'number' && (pos.entryMid <= 0 || pos.entryMid >= 1)) return null;
      return pos;
    }
    return null;
  } catch {
    return null;
  }
}

/** Load B4 tier config from b4_state.results_json. Returns defaults if not found. */
export async function loadB4Config(): Promise<B4TierConfig> {
  try {
    const { data } = await getDb()
      .from('b4_state')
      .select('results_json')
      .eq('id', 'default')
      .maybeSingle();
    if (data?.results_json && typeof data.results_json === 'object' && !Array.isArray(data.results_json)) {
      const cfg = data.results_json as Record<string, unknown>;
      if (cfg.t1_spread != null) {
        return {
          t1_spread: Number(cfg.t1_spread) || DEFAULT_B4_CONFIG.t1_spread,
          t2_spread: Number(cfg.t2_spread) || DEFAULT_B4_CONFIG.t2_spread,
          t3_spread: Number(cfg.t3_spread) || DEFAULT_B4_CONFIG.t3_spread,
          t2_block_min: Number(cfg.t2_block_min) || DEFAULT_B4_CONFIG.t2_block_min,
          t3_block_min: Number(cfg.t3_block_min) || DEFAULT_B4_CONFIG.t3_block_min,
          position_size: Number(cfg.position_size) || DEFAULT_B4_CONFIG.position_size,
          b123c_position_size: Number(cfg.b123c_position_size) || DEFAULT_B4_CONFIG.b123c_position_size,
        };
      }
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_B4_CONFIG };
}

/** Save B4 tier config to b4_state.results_json. */
export async function saveB4Config(config: B4TierConfig): Promise<void> {
  try {
    await getDb().from('b4_state').update({
      results_json: config as unknown as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    }).eq('id', 'default');
  } catch (e) {
    console.error('[saveB4Config] failed:', e instanceof Error ? e.message : e);
  }
}

/** Reset B4 state for fresh start with new strategy. */
export async function resetB4State(startingBankroll: number, config: B4TierConfig): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await getDb().from('b4_state').upsert({
    id: 'default',
    bankroll: startingBankroll,
    max_bankroll: startingBankroll,
    consecutive_losses: 0,
    cooldown_until_ms: 0,
    results_json: config as unknown as Record<string, unknown>,
    daily_start_bankroll: startingBankroll,
    daily_start_date: today,
    half_kelly_trades_left: 0,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'id' });
}

/** Set emergency_off flag in bot_config. */
export async function setEmergencyOff(off: boolean): Promise<void> {
  await getDb().from('bot_config').update({ emergency_off: off }).eq('id', 'default');
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
