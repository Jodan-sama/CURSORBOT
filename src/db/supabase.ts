/**
 * Supabase client and helpers for bot config, positions log, spread thresholds, and B3 blocks.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { BOT_SPREAD_THRESHOLD_PCT, type SpreadThresholdsMatrix } from '../kalshi/spread.js';

export type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP';
export type BotId = 'B1' | 'B2' | 'B3' | 'B4' | 'B5' | 'B1c' | 'B2c' | 'B3c';
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

export type DashboardConfig = {
  emergency_off: boolean;
  spreadThresholds: SpreadThresholdsMatrix;
  delays: Awaited<ReturnType<typeof getBotDelays>>;
  positionSizesMatrix: PositionSizesMatrix;
};

/** One batch for 15-min cache: emergency, entry thresholds, delays, position sizes. */
export async function getDashboardConfig(): Promise<DashboardConfig> {
  const [config, spreadThresholds, posResult] = await Promise.all([
    getBotConfig(),
    getSpreadThresholds(),
    getDb().from('bot_position_sizes').select('bot, asset, size_kalshi, size_polymarket'),
  ]);
  const rows = posResult.error ? [] : (posResult.data ?? []);
  const defaultK = config.position_size_kalshi;
  const defaultP = config.position_size_polymarket;
  const kalshi: PositionSizesMatrix['kalshi'] = { B1: { BTC: defaultK, ETH: defaultK, SOL: defaultK, XRP: defaultK }, B2: { BTC: defaultK, ETH: defaultK, SOL: defaultK, XRP: defaultK }, B3: { BTC: defaultK, ETH: defaultK, SOL: defaultK, XRP: defaultK } };
  const polymarket: PositionSizesMatrix['polymarket'] = { B1: { BTC: defaultP, ETH: defaultP, SOL: defaultP, XRP: defaultP }, B2: { BTC: defaultP, ETH: defaultP, SOL: defaultP, XRP: defaultP }, B3: { BTC: defaultP, ETH: defaultP, SOL: defaultP, XRP: defaultP } };
  for (const row of rows as { bot: string; asset: Asset; size_kalshi?: number; size_polymarket?: number }[]) {
    if (row.bot === 'B1' || row.bot === 'B2' || row.bot === 'B3') {
      if (row.size_kalshi != null) kalshi[row.bot][row.asset] = row.size_kalshi;
      if (row.size_polymarket != null) polymarket[row.bot][row.asset] = row.size_polymarket;
    }
  }
  const delays: DashboardConfig['delays'] = {
    b3BlockMin: Number(config.b3_block_min) || 60,
    b2HighSpreadThresholdPct: Number(config.b2_high_spread_threshold_pct) || 0.55,
    b2HighSpreadBlockMin: Number(config.b2_high_spread_block_min) || 15,
    b3EarlyHighSpreadPct: Number(config.b3_early_high_spread_pct) ?? 1.8,
    b3EarlyHighSpreadBlockMin: Number(config.b3_early_high_spread_block_min) ?? 15,
  };
  return {
    emergency_off: config.emergency_off,
    spreadThresholds,
    delays,
    positionSizesMatrix: { kalshi, polymarket },
  };
}

/** Matrix (venue -> bot -> asset -> size) for B1/B2/B3. One getBotConfig + one query instead of 24 getPositionSize calls. */
export type PositionSizesMatrix = {
  kalshi: Record<'B1' | 'B2' | 'B3', Record<Asset, number>>;
  polymarket: Record<'B1' | 'B2' | 'B3', Record<Asset, number>>;
};

export async function getPositionSizesMatrix(): Promise<PositionSizesMatrix> {
  const [config, result] = await Promise.all([
    getBotConfig(),
    getDb().from('bot_position_sizes').select('bot, asset, size_kalshi, size_polymarket'),
  ]);
  const rows = result.error ? [] : (result.data ?? []);
  const defaultK = config.position_size_kalshi;
  const defaultP = config.position_size_polymarket;
  const kalshi: PositionSizesMatrix['kalshi'] = { B1: { BTC: defaultK, ETH: defaultK, SOL: defaultK, XRP: defaultK }, B2: { BTC: defaultK, ETH: defaultK, SOL: defaultK, XRP: defaultK }, B3: { BTC: defaultK, ETH: defaultK, SOL: defaultK, XRP: defaultK } };
  const polymarket: PositionSizesMatrix['polymarket'] = { B1: { BTC: defaultP, ETH: defaultP, SOL: defaultP, XRP: defaultP }, B2: { BTC: defaultP, ETH: defaultP, SOL: defaultP, XRP: defaultP }, B3: { BTC: defaultP, ETH: defaultP, SOL: defaultP, XRP: defaultP } };
  for (const row of rows as { bot: string; asset: Asset; size_kalshi?: number; size_polymarket?: number }[]) {
    if (row.bot === 'B1' || row.bot === 'B2' || row.bot === 'B3') {
      if (row.size_kalshi != null) kalshi[row.bot][row.asset] = row.size_kalshi;
      if (row.size_polymarket != null) polymarket[row.bot][row.asset] = row.size_polymarket;
    }
  }
  return { kalshi, polymarket };
}

/** Get position size for a venue (with optional per-bot/asset override). */
export function getPositionSizeFromMatrix(
  matrix: PositionSizesMatrix,
  venue: Venue,
  bot: 'B1' | 'B2' | 'B3',
  asset: Asset
): number {
  return venue === 'kalshi' ? matrix.kalshi[bot][asset] : matrix.polymarket[bot][asset];
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

/** Log a new position. Logs even when position_size is 0 so resolver can record actual win/loss from CLOB fill. */
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

/** All (bot, asset) with a position in this 15m window. One query instead of up to 12. Returns keys like 'B1-BTC'. */
export async function getPositionsInWindowB123(windowStartMs: number): Promise<Set<string>> {
  const windowStart = new Date(windowStartMs).toISOString();
  const { data, error } = await getDb()
    .from('positions')
    .select('bot, asset')
    .in('bot', ['B1', 'B2', 'B3'])
    .gte('entered_at', windowStart);
  if (error) return new Set();
  const set = new Set<string>();
  for (const row of (data ?? []) as { bot: string; asset: Asset }[]) set.add(`${row.bot}-${row.asset}`);
  return set;
}

/** All (bot, asset) with a position in this 15m window for B1c/B2c/B3c. One query per tick. Returns keys like 'B1c-BTC'. */
export async function getPositionsInWindowB123c(windowStartMs: number): Promise<Set<string>> {
  const windowStart = new Date(windowStartMs).toISOString();
  const { data, error } = await getDb()
    .from('positions')
    .select('bot, asset')
    .in('bot', ['B1c', 'B2c', 'B3c'])
    .gte('entered_at', windowStart);
  if (error) return new Set();
  const set = new Set<string>();
  for (const row of (data ?? []) as { bot: string; asset: Asset }[]) set.add(`${row.bot}-${row.asset}`);
  return set;
}

/** B123c dashboard config: thresholds, delays, position size, emergency off. One burst every 15 min. */
export async function getB123cDashboardConfig(): Promise<{
  spreadThresholds: SpreadThresholdsMatrix;
  delays: Awaited<ReturnType<typeof getBotDelays>>;
  positionSize: number;
  emergencyOff: boolean;
}> {
  const [spreadThresholds, delays, b4Res] = await Promise.all([
    getSpreadThresholds(),
    getBotDelays(),
    getDb().from('b4_state').select('cooldown_until_ms, b123c_cooldown_until_ms, results_json').eq('id', 'default').maybeSingle(),
  ]);
  const data = b4Res.data as { cooldown_until_ms?: number; b123c_cooldown_until_ms?: number; results_json?: Record<string, unknown> } | null;
  const emergencyOff = data?.b123c_cooldown_until_ms === 1;
  let positionSize = DEFAULT_B4_CONFIG.b123c_position_size;
  if (data?.results_json && typeof data.results_json === 'object' && !Array.isArray(data.results_json)) {
    const v = (data.results_json as Record<string, unknown>).b123c_position_size;
    if (typeof v === 'number' && v > 0) positionSize = v;
  }
  return { spreadThresholds, delays, positionSize, emergencyOff };
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

/** All assets currently blocked (B3 filled recently). One query instead of 4. */
export async function getAssetBlocksAll(): Promise<Set<Asset>> {
  const now = new Date().toISOString();
  const { data, error } = await getDb()
    .from('asset_blocks')
    .select('asset')
    .gt('block_until', now);
  if (error) throw new Error(`getAssetBlocksAll: ${error.message}`);
  const set = new Set<Asset>();
  for (const row of (data ?? []) as { asset: Asset }[]) set.add(row.asset);
  return set;
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
  /** How long T3 blocks T2 (min). */
  t3_blocks_t2_min: number;
  /** How long T3 blocks T1 (min). */
  t3_blocks_t1_min: number;
  position_size: number;
  b123c_position_size: number;
  early_guard_spread_pct: number;
  early_guard_cooldown_min: number;
  /** Add this % to T1 threshold Mon–Fri 7–11am MST only. 0 = off. */
  t1_mst_bump_pct?: number;
  /** Add this % to T2 threshold Mon–Fri 7–11am MST only. 0 = off. */
  t2_mst_bump_pct?: number;
}

export const DEFAULT_B4_CONFIG: B4TierConfig = {
  t1_spread: 0.10,
  t2_spread: 0.21,
  t3_spread: 0.45,
  t2_block_min: 5,
  t3_blocks_t2_min: 15,
  t3_blocks_t1_min: 45,
  position_size: 5,
  b123c_position_size: 5,
  early_guard_spread_pct: 0.6,
  early_guard_cooldown_min: 60,
  t1_mst_bump_pct: 0,
  t2_mst_bump_pct: 0.015,
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

/** B4 spread-runner: load tier blocks and early-guard cooldown (read on startup only). */
export interface B4BlocksRow {
  t1BlockedUntilMs: number;
  t2BlockedUntilMs: number;
  earlyGuardCooldownUntilMs: number;
}

export async function getB4Blocks(): Promise<B4BlocksRow | null> {
  try {
    const [tierRes, guardRes] = await Promise.all([
      getDb().from('b4_tier_blocks').select('t1_blocked_until_ms, t2_blocked_until_ms').eq('id', 'default').maybeSingle(),
      getDb().from('b4_early_guard').select('cooldown_until_ms').eq('id', 'default').maybeSingle(),
    ]);
    const tier = (tierRes as { data?: { t1_blocked_until_ms?: number; t2_blocked_until_ms?: number } | null }).data;
    const guard = (guardRes as { data?: { cooldown_until_ms?: number } | null }).data;
    return {
      t1BlockedUntilMs: Number(tier?.t1_blocked_until_ms) || 0,
      t2BlockedUntilMs: Number(tier?.t2_blocked_until_ms) || 0,
      earlyGuardCooldownUntilMs: Number(guard?.cooldown_until_ms) || 0,
    };
  } catch (e) {
    console.warn('[getB4Blocks] failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

/** B4 spread-runner: persist tier blocks when T2 or T3 places (write-through only). */
export async function updateB4TierBlocks(t1BlockedUntilMs: number, t2BlockedUntilMs: number): Promise<void> {
  try {
    await getDb().from('b4_tier_blocks').upsert({
      id: 'default',
      t1_blocked_until_ms: t1BlockedUntilMs,
      t2_blocked_until_ms: t2BlockedUntilMs,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
  } catch (e) {
    console.warn('[updateB4TierBlocks] failed:', e instanceof Error ? e.message : e);
  }
}

/** B4 spread-runner: persist early-guard cooldown when triggered (write-through only). */
export async function updateB4EarlyGuard(cooldownUntilMs: number): Promise<void> {
  try {
    await getDb().from('b4_early_guard').upsert({
      id: 'default',
      cooldown_until_ms: cooldownUntilMs,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
  } catch (e) {
    console.warn('[updateB4EarlyGuard] failed:', e instanceof Error ? e.message : e);
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
        const t1Bump = cfg.t1_mst_bump_pct != null ? Number(cfg.t1_mst_bump_pct) : DEFAULT_B4_CONFIG.t1_mst_bump_pct ?? 0;
        const t2Bump = cfg.t2_mst_bump_pct != null ? Number(cfg.t2_mst_bump_pct) : DEFAULT_B4_CONFIG.t2_mst_bump_pct ?? 0.015;
        const t3BlocksT2 = cfg.t3_blocks_t2_min != null ? Number(cfg.t3_blocks_t2_min) : (cfg.t3_block_min != null ? Number(cfg.t3_block_min) : DEFAULT_B4_CONFIG.t3_blocks_t2_min);
        const t3BlocksT1 = cfg.t3_blocks_t1_min != null ? Number(cfg.t3_blocks_t1_min) : DEFAULT_B4_CONFIG.t3_blocks_t1_min;
        return {
          t1_spread: Number(cfg.t1_spread) || DEFAULT_B4_CONFIG.t1_spread,
          t2_spread: Number(cfg.t2_spread) || DEFAULT_B4_CONFIG.t2_spread,
          t3_spread: Number(cfg.t3_spread) || DEFAULT_B4_CONFIG.t3_spread,
          t2_block_min: Number(cfg.t2_block_min) || DEFAULT_B4_CONFIG.t2_block_min,
          t3_blocks_t2_min: t3BlocksT2,
          t3_blocks_t1_min: t3BlocksT1,
          position_size: Number(cfg.position_size) || DEFAULT_B4_CONFIG.position_size,
          b123c_position_size: Number(cfg.b123c_position_size) || DEFAULT_B4_CONFIG.b123c_position_size,
          early_guard_spread_pct: Number(cfg.early_guard_spread_pct) || DEFAULT_B4_CONFIG.early_guard_spread_pct,
          early_guard_cooldown_min: Number(cfg.early_guard_cooldown_min) || DEFAULT_B4_CONFIG.early_guard_cooldown_min,
          t1_mst_bump_pct: t1Bump,
          t2_mst_bump_pct: t2Bump,
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

// ---------------------------------------------------------------------------
// B5 spread-runner (D3): per-asset tier config, blocks, early guard
// ---------------------------------------------------------------------------

export interface B5TierConfig {
  eth_t1_spread: number;
  eth_t2_spread: number;
  eth_t3_spread: number;
  sol_t1_spread: number;
  sol_t2_spread: number;
  sol_t3_spread: number;
  xrp_t1_spread: number;
  xrp_t2_spread: number;
  xrp_t3_spread: number;
  t2_block_min: number;
  /** How long T3 blocks T2 (min). Per-asset blocks, same duration for all assets. */
  t3_blocks_t2_min: number;
  /** How long T3 blocks T1 (min). Per-asset blocks, same duration for all assets. */
  t3_blocks_t1_min: number;
  position_size: number;
  early_guard_spread_pct: number;
  early_guard_cooldown_min: number;
}

export const DEFAULT_B5_CONFIG: B5TierConfig = {
  eth_t1_spread: 0.32, eth_t2_spread: 0.181, eth_t3_spread: 0.110,
  sol_t1_spread: 0.32, sol_t2_spread: 0.206, sol_t3_spread: 0.121,
  xrp_t1_spread: 0.32, xrp_t2_spread: 0.206, xrp_t3_spread: 0.121,
  t2_block_min: 5, t3_blocks_t2_min: 15, t3_blocks_t1_min: 60, position_size: 5,
  early_guard_spread_pct: 0.45, early_guard_cooldown_min: 60,
};

export interface B5StateRow {
  bankroll: number;
  max_bankroll: number;
  consecutive_losses: number;
  cooldown_until_ms: number;
  results_json: B5TierConfig | Record<string, unknown>;
  daily_start_bankroll: number;
  daily_start_date: string;
  half_kelly_trades_left: number;
  updated_at: string;
}

export async function isB5EmergencyOff(): Promise<boolean> {
  try {
    const { data } = await getDb()
      .from('b5_state')
      .select('cooldown_until_ms')
      .eq('id', 'default')
      .maybeSingle();
    return data?.cooldown_until_ms === 1;
  } catch {
    return false;
  }
}

export async function setB5EmergencyOff(off: boolean): Promise<void> {
  await getDb().from('b5_state').update({
    cooldown_until_ms: off ? 1 : 0,
    updated_at: new Date().toISOString(),
  }).eq('id', 'default');
}

export type B5Asset = 'ETH' | 'SOL' | 'XRP';

export interface B5BlocksPerAsset {
  t1BlockedUntilMs: number;
  t2BlockedUntilMs: number;
}

export interface B5BlocksRow {
  perAsset: Record<B5Asset, B5BlocksPerAsset>;
  earlyGuardCooldownUntilMs: number;
}

const B5_ASSET_IDS: B5Asset[] = ['ETH', 'SOL', 'XRP'];

export async function getB5Blocks(): Promise<B5BlocksRow | null> {
  try {
    const [tierRes, guardRes] = await Promise.all([
      getDb().from('b5_tier_blocks').select('id, t1_blocked_until_ms, t2_blocked_until_ms').in('id', B5_ASSET_IDS),
      getDb().from('b5_early_guard').select('cooldown_until_ms').eq('id', 'default').maybeSingle(),
    ]);
    const tierRows = (tierRes as { data?: { id: string; t1_blocked_until_ms?: number; t2_blocked_until_ms?: number }[] }).data ?? [];
    const guard = (guardRes as { data?: { cooldown_until_ms?: number } | null }).data;
    const perAsset: Record<B5Asset, B5BlocksPerAsset> = {
      ETH: { t1BlockedUntilMs: 0, t2BlockedUntilMs: 0 },
      SOL: { t1BlockedUntilMs: 0, t2BlockedUntilMs: 0 },
      XRP: { t1BlockedUntilMs: 0, t2BlockedUntilMs: 0 },
    };
    for (const row of tierRows) {
      if (row.id === 'ETH' || row.id === 'SOL' || row.id === 'XRP') {
        perAsset[row.id] = {
          t1BlockedUntilMs: Number(row.t1_blocked_until_ms) || 0,
          t2BlockedUntilMs: Number(row.t2_blocked_until_ms) || 0,
        };
      }
    }
    return {
      perAsset,
      earlyGuardCooldownUntilMs: Number(guard?.cooldown_until_ms) || 0,
    };
  } catch (e) {
    console.warn('[getB5Blocks] failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

export async function updateB5TierBlocks(asset: B5Asset, t1BlockedUntilMs: number, t2BlockedUntilMs: number): Promise<void> {
  try {
    await getDb().from('b5_tier_blocks').upsert({
      id: asset,
      t1_blocked_until_ms: t1BlockedUntilMs,
      t2_blocked_until_ms: t2BlockedUntilMs,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
  } catch (e) {
    console.warn('[updateB5TierBlocks] failed:', e instanceof Error ? e.message : e);
  }
}

export async function updateB5EarlyGuard(cooldownUntilMs: number): Promise<void> {
  try {
    await getDb().from('b5_early_guard').upsert({
      id: 'default',
      cooldown_until_ms: cooldownUntilMs,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
  } catch (e) {
    console.warn('[updateB5EarlyGuard] failed:', e instanceof Error ? e.message : e);
  }
}

export async function loadB5Config(): Promise<B5TierConfig> {
  try {
    const { data } = await getDb()
      .from('b5_state')
      .select('results_json')
      .eq('id', 'default')
      .maybeSingle();
    if (data?.results_json && typeof data.results_json === 'object' && !Array.isArray(data.results_json)) {
      const cfg = data.results_json as Record<string, unknown>;
      const get = (k: string, d: number) => (cfg[k] != null ? Number(cfg[k]) : d);
      const t3BlocksT2 = cfg.t3_blocks_t2_min != null ? Number(cfg.t3_blocks_t2_min) : (cfg.t3_block_min != null ? Number(cfg.t3_block_min) : DEFAULT_B5_CONFIG.t3_blocks_t2_min);
      const t3BlocksT1 = cfg.t3_blocks_t1_min != null ? Number(cfg.t3_blocks_t1_min) : DEFAULT_B5_CONFIG.t3_blocks_t1_min;
      return {
        eth_t1_spread: get('eth_t1_spread', DEFAULT_B5_CONFIG.eth_t1_spread),
        eth_t2_spread: get('eth_t2_spread', DEFAULT_B5_CONFIG.eth_t2_spread),
        eth_t3_spread: get('eth_t3_spread', DEFAULT_B5_CONFIG.eth_t3_spread),
        sol_t1_spread: get('sol_t1_spread', DEFAULT_B5_CONFIG.sol_t1_spread),
        sol_t2_spread: get('sol_t2_spread', DEFAULT_B5_CONFIG.sol_t2_spread),
        sol_t3_spread: get('sol_t3_spread', DEFAULT_B5_CONFIG.sol_t3_spread),
        xrp_t1_spread: get('xrp_t1_spread', DEFAULT_B5_CONFIG.xrp_t1_spread),
        xrp_t2_spread: get('xrp_t2_spread', DEFAULT_B5_CONFIG.xrp_t2_spread),
        xrp_t3_spread: get('xrp_t3_spread', DEFAULT_B5_CONFIG.xrp_t3_spread),
        t2_block_min: get('t2_block_min', DEFAULT_B5_CONFIG.t2_block_min),
        t3_blocks_t2_min: t3BlocksT2,
        t3_blocks_t1_min: t3BlocksT1,
        position_size: get('position_size', DEFAULT_B5_CONFIG.position_size),
        early_guard_spread_pct: get('early_guard_spread_pct', DEFAULT_B5_CONFIG.early_guard_spread_pct),
        early_guard_cooldown_min: get('early_guard_cooldown_min', DEFAULT_B5_CONFIG.early_guard_cooldown_min),
      };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_B5_CONFIG };
}

export async function saveB5Config(config: B5TierConfig): Promise<void> {
  try {
    await getDb().from('b5_state').update({
      results_json: config as unknown as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    }).eq('id', 'default');
  } catch (e) {
    console.error('[saveB5Config] failed:', e instanceof Error ? e.message : e);
  }
}

export async function loadB5State(): Promise<B5StateRow | null> {
  try {
    const { data, error } = await getDb()
      .from('b5_state')
      .select('*')
      .eq('id', 'default')
      .maybeSingle();
    if (error || !data) return null;
    const row = data as Record<string, unknown>;
    return {
      bankroll: Number(row.bankroll) || 50,
      max_bankroll: Number(row.max_bankroll) || 50,
      consecutive_losses: Number(row.consecutive_losses) || 0,
      cooldown_until_ms: Number(row.cooldown_until_ms) || 0,
      results_json: (row.results_json && typeof row.results_json === 'object') ? row.results_json as B5TierConfig : {},
      daily_start_bankroll: Number(row.daily_start_bankroll) || 50,
      daily_start_date: String(row.daily_start_date ?? ''),
      half_kelly_trades_left: Number(row.half_kelly_trades_left) || 0,
      updated_at: String(row.updated_at ?? ''),
    };
  } catch {
    return null;
  }
}

export async function resetB5State(startingBankroll: number, config: B5TierConfig): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await getDb().from('b5_state').upsert({
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
