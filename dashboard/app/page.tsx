'use client';

import { useEffect, useState } from 'react';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let supabaseInstance: SupabaseClient | null = null;
function getSupabase(): SupabaseClient {
  if (!supabaseInstance) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required');
    supabaseInstance = createClient(url, key);
  }
  return supabaseInstance;
}

const BOTS = ['B1', 'B2', 'B3'] as const;
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'] as const;

const buttonStyle: React.CSSProperties = {
  padding: '8px 16px',
  backgroundColor: '#0D9488',
  color: '#000',
  border: 'none',
  borderRadius: 6,
  fontWeight: 600,
  cursor: 'pointer',
};
const buttonDisabledStyle: React.CSSProperties = { ...buttonStyle, opacity: 0.6, cursor: 'not-allowed' };

const headingStyle: React.CSSProperties = { fontFamily: 'var(--font-din-condensed), Barlow Condensed, sans-serif' };

/** Format ISO timestamp as MST (Utah), e.g. "10:41" or "Feb 10, 10:41". */
function formatMst(iso: string, withDate = false): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const tz = 'America/Denver';
  if (withDate) {
    return d.toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return d.toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
}

type Config = {
  emergency_off: boolean;
  position_size_kalshi: number;
  position_size_polymarket: number;
  b3_block_min: number;
  b2_high_spread_threshold_pct: number;
  b2_high_spread_block_min: number;
  b3_early_high_spread_pct?: number;
  b3_early_high_spread_block_min?: number;
  updated_at: string;
};

type Position = {
  id: string;
  entered_at: string;
  bot: string;
  asset: string;
  venue: string;
  strike_spread_pct: number;
  position_size: number;
  ticker_or_slug: string | null;
  order_id: string | null;
  raw?: { price_source?: string } | null;
  outcome?: 'win' | 'loss' | 'no_fill' | null;
  resolved_at?: string | null;
};

type SpreadRow = { bot: string; asset: string; threshold_pct: number };

type ErrorLog = {
  id: string;
  created_at: string;
  message: string;
  context: Record<string, unknown> | null;
  stack: string | null;
};

type PolySkipRow = {
  id: string;
  created_at: string;
  bot: string;
  asset: string;
  reason: string;
  kalshi_placed: boolean;
};

export default function Dashboard() {
  const [config, setConfig] = useState<Config | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [b4Positions, setB4Positions] = useState<Position[]>([]);
  const [b4Unfilled, setB4Unfilled] = useState<Position[]>([]);
  const [b4State, setB4State] = useState<{ bankroll: number; max_bankroll: number; daily_start_bankroll: number; daily_start_date: string; half_kelly_trades_left: number; consecutive_losses: number; cooldown_until_ms: number; b123c_cooldown_until_ms?: number; results_json: Record<string, unknown> | boolean[]; updated_at: string } | null>(null);
  const [b4Config, setB4Config] = useState<{ t1_spread: string; t2_spread: string; t3_spread: string; t2_block_min: string; t3_blocks_t2_min: string; t3_blocks_t1_min: string; position_size: string; b123c_position_size: string; early_guard_spread_pct: string; early_guard_cooldown_min: string; t1_mst_bump_pct: string; t2_mst_bump_pct: string }>({
    t1_spread: '0.10', t2_spread: '0.21', t3_spread: '0.45', t2_block_min: '5', t3_blocks_t2_min: '15', t3_blocks_t1_min: '45', position_size: '5', b123c_position_size: '5', early_guard_spread_pct: '0.6', early_guard_cooldown_min: '60', t1_mst_bump_pct: '0', t2_mst_bump_pct: '0.015',
  });
  const [b123cPositions, setB123cPositions] = useState<Position[]>([]);
  const [b123cUnfilled, setB123cUnfilled] = useState<Position[]>([]);
  const [b123PolyFilled, setB123PolyFilled] = useState<Position[]>([]);
  const [errors, setErrors] = useState<ErrorLog[]>([]);
  const [polySkips, setPolySkips] = useState<PolySkipRow[]>([]);
  const [spreadRows, setSpreadRows] = useState<SpreadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [botSizes, setBotSizes] = useState<Record<string, { kalshi: string; poly: string }>>({
    B1: { kalshi: '', poly: '' },
    B2: { kalshi: '', poly: '' },
    B3: { kalshi: '', poly: '' },
  });
  const [spreadEdits, setSpreadEdits] = useState<Record<string, string>>({});
  const [delayEdits, setDelayEdits] = useState<{ b3: string; b2SpreadThreshold: string; b2HighSpread: string; b3EarlySpreadPct: string; b3EarlySpreadBlock: string }>({
    b3: '',
    b2SpreadThreshold: '',
    b2HighSpread: '',
    b3EarlySpreadPct: '',
    b3EarlySpreadBlock: '',
  });
  const [csvLoading, setCsvLoading] = useState(false);
  const [b4CsvLoading, setB4CsvLoading] = useState(false);
  const [b5CsvLoading, setB5CsvLoading] = useState(false);
  const [b123cCsvLoading, setB123cCsvLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [b5State, setB5State] = useState<{ bankroll: number; cooldown_until_ms: number; results_json: Record<string, unknown>; updated_at: string } | null>(null);
  const [b5Config, setB5Config] = useState<{
    eth_t1_spread: string; eth_t2_spread: string; eth_t3_spread: string;
    sol_t1_spread: string; sol_t2_spread: string; sol_t3_spread: string;
    xrp_t1_spread: string; xrp_t2_spread: string; xrp_t3_spread: string;
    t2_block_min: string; t3_blocks_t2_min: string; t3_blocks_t1_min: string; position_size: string;
    early_guard_spread_pct: string; early_guard_cooldown_min: string;
  }>({
    eth_t1_spread: '0.32', eth_t2_spread: '0.181', eth_t3_spread: '0.110',
    sol_t1_spread: '0.32', sol_t2_spread: '0.206', sol_t3_spread: '0.121',
    xrp_t1_spread: '0.32', xrp_t2_spread: '0.206', xrp_t3_spread: '0.121',
    t2_block_min: '5', t3_blocks_t2_min: '15', t3_blocks_t1_min: '60', position_size: '5',
    early_guard_spread_pct: '0.45', early_guard_cooldown_min: '60',
  });
  const [b5Positions, setB5Positions] = useState<Position[]>([]);
  const [b5Unfilled, setB5Unfilled] = useState<Position[]>([]);

  async function load() {
    setLoadError(null);
    try {
      const spreadPromise = getSupabase().from('spread_thresholds').select('bot, asset, threshold_pct');
      const b4StatePromise = getSupabase().from('b4_state').select('*').eq('id', 'default').maybeSingle();
      const b5StatePromise = getSupabase().from('b5_state').select('*').eq('id', 'default').maybeSingle();
      const supabase = getSupabase();
      const b123Base = () => supabase.from('positions').select('*').in('bot', ['B1', 'B2', 'B3']).order('entered_at', { ascending: false });
      const [page0, page1, page2] = await Promise.all([
        b123Base().range(0, 999),
        b123Base().range(1000, 1999),
        b123Base().range(2000, 2999),
      ]);
      const posData = [
        ...(page0.data ?? []),
        ...(page1.data ?? []),
        ...(page2.data ?? []),
      ];
      const [
        { data: configData },
        _posPlaceholder,
        { data: b123PolyFilledData },
        { data: b4PosData },
        { data: b4UnfilledData },
        { data: b5PosData },
        { data: b5UnfilledData },
        { data: b123cPosData },
        { data: b123cUnfilledData },
        { data: errData },
        { data: polySkipData },
        spreadResult,
        { data: botSizesData },
        b4StateResult,
        b5StateResult,
      ] = await Promise.all([
        supabase.from('bot_config').select('*').eq('id', 'default').single(),
        Promise.resolve({ data: null }),
        supabase.from('positions').select('*').in('bot', ['B1', 'B2', 'B3']).eq('venue', 'polymarket').in('outcome', ['win', 'loss']).order('entered_at', { ascending: false }).limit(200),
        getSupabase().from('positions').select('*').eq('bot', 'B4').in('outcome', ['win', 'loss']).order('entered_at', { ascending: false }).limit(200),
        getSupabase().from('positions').select('*').eq('bot', 'B4').eq('outcome', 'no_fill').order('entered_at', { ascending: false }).limit(100),
        getSupabase().from('positions').select('*').eq('bot', 'B5').in('outcome', ['win', 'loss']).order('entered_at', { ascending: false }).limit(200),
        getSupabase().from('positions').select('*').eq('bot', 'B5').or('outcome.eq.no_fill,outcome.is.null').order('entered_at', { ascending: false }).limit(100),
        getSupabase().from('positions').select('*').in('bot', ['B1c', 'B2c', 'B3c']).in('outcome', ['win', 'loss']).order('entered_at', { ascending: false }).limit(200),
        getSupabase().from('positions').select('*').in('bot', ['B1c', 'B2c', 'B3c']).or('outcome.eq.no_fill,outcome.is.null').order('entered_at', { ascending: false }).limit(100),
        getSupabase().from('error_log').select('*').order('created_at', { ascending: false }).limit(10),
        getSupabase().from('poly_skip_log').select('*').order('created_at', { ascending: false }).limit(50),
        Promise.resolve(spreadPromise).catch(() => ({ data: [] })),
        getSupabase().from('bot_position_sizes').select('bot, asset, size_kalshi, size_polymarket'),
        Promise.resolve(b4StatePromise).catch(() => ({ data: null })),
        Promise.resolve(b5StatePromise).catch(() => ({ data: null })),
      ]);
      setConfig(configData ?? null);
      setPositions((posData ?? []) as Position[]);
      setB4Positions((b4PosData ?? []) as Position[]);
      setB4Unfilled((b4UnfilledData ?? []) as Position[]);
      setB5Positions((b5PosData ?? []) as Position[]);
      setB5Unfilled((b5UnfilledData ?? []) as Position[]);
      setB123cPositions((b123cPosData ?? []) as Position[]);
      setB123cUnfilled((b123cUnfilledData ?? []) as Position[]);
      setB123PolyFilled((b123PolyFilledData ?? []) as Position[]);
      const b4Row = (b4StateResult as { data: unknown }).data as typeof b4State;
      setB4State(b4Row ?? null);
      if (b4Row?.results_json && typeof b4Row.results_json === 'object' && !Array.isArray(b4Row.results_json)) {
        const cfg = b4Row.results_json as Record<string, unknown>;
        setB4Config({
          t1_spread: cfg.t1_spread != null ? String(cfg.t1_spread) : '0.10',
          t2_spread: cfg.t2_spread != null ? String(cfg.t2_spread) : '0.21',
          t3_spread: cfg.t3_spread != null ? String(cfg.t3_spread) : '0.45',
          t2_block_min: cfg.t2_block_min != null ? String(cfg.t2_block_min) : '5',
          t3_blocks_t2_min: cfg.t3_blocks_t2_min != null ? String(cfg.t3_blocks_t2_min) : (cfg.t3_block_min != null ? String(cfg.t3_block_min) : '15'),
          t3_blocks_t1_min: cfg.t3_blocks_t1_min != null ? String(cfg.t3_blocks_t1_min) : '45',
          position_size: cfg.position_size != null ? String(cfg.position_size) : '5',
          b123c_position_size: cfg.b123c_position_size != null ? String(cfg.b123c_position_size) : '5',
          early_guard_spread_pct: cfg.early_guard_spread_pct != null ? String(cfg.early_guard_spread_pct) : '0.6',
          early_guard_cooldown_min: cfg.early_guard_cooldown_min != null ? String(cfg.early_guard_cooldown_min) : '60',
          t1_mst_bump_pct: cfg.t1_mst_bump_pct != null ? String(cfg.t1_mst_bump_pct) : '0',
          t2_mst_bump_pct: cfg.t2_mst_bump_pct != null ? String(cfg.t2_mst_bump_pct) : '0.015',
        });
      }
      const b5Row = (b5StateResult as { data: unknown }).data as typeof b5State;
      setB5State(b5Row ?? null);
      if (b5Row?.results_json && typeof b5Row.results_json === 'object' && !Array.isArray(b5Row.results_json)) {
        const cfg = b5Row.results_json as Record<string, unknown>;
        const s = (k: string, d: string) => (cfg[k] != null ? String(cfg[k]) : d);
        setB5Config({
          eth_t1_spread: s('eth_t1_spread', '0.32'), eth_t2_spread: s('eth_t2_spread', '0.181'), eth_t3_spread: s('eth_t3_spread', '0.110'),
          sol_t1_spread: s('sol_t1_spread', '0.32'), sol_t2_spread: s('sol_t2_spread', '0.206'), sol_t3_spread: s('sol_t3_spread', '0.121'),
          xrp_t1_spread: s('xrp_t1_spread', '0.32'), xrp_t2_spread: s('xrp_t2_spread', '0.206'), xrp_t3_spread: s('xrp_t3_spread', '0.121'),
          t2_block_min: s('t2_block_min', '5'), t3_blocks_t2_min: s('t3_blocks_t2_min', cfg.t3_block_min != null ? String(cfg.t3_block_min) : '15'), t3_blocks_t1_min: s('t3_blocks_t1_min', '60'), position_size: s('position_size', '5'),
          early_guard_spread_pct: s('early_guard_spread_pct', '0.45'), early_guard_cooldown_min: s('early_guard_cooldown_min', '60'),
        });
      }
      setErrors((errData ?? []) as ErrorLog[]);
      setPolySkips((polySkipData ?? []) as PolySkipRow[]);
      const rows = ((spreadResult as { data: SpreadRow[] }).data ?? []) as SpreadRow[];
      setSpreadRows(rows);
      const defaults: Record<string, string> = {
        'B1-BTC': '0.21', 'B1-ETH': '0.23', 'B1-SOL': '0.27', 'B1-XRP': '0.27',
        'B2-BTC': '0.57', 'B2-ETH': '0.57', 'B2-SOL': '0.62', 'B2-XRP': '0.62',
        'B3-BTC': '1', 'B3-ETH': '1', 'B3-SOL': '1', 'B3-XRP': '1',
      };
      const edits: Record<string, string> = { ...defaults };
      rows.forEach((r) => {
        edits[`${r.bot}-${r.asset}`] = String(r.threshold_pct);
      });
      setSpreadEdits(edits);
      const defaultK = configData ? String(configData.position_size_kalshi) : '';
      const defaultP = configData ? String(configData.position_size_polymarket) : '';
      const sizesRows = (botSizesData ?? []) as { bot: string; asset: string; size_kalshi: number | null; size_polymarket: number | null }[];
      const nextBotSizes: Record<string, { kalshi: string; poly: string }> = { B1: { kalshi: defaultK, poly: defaultP }, B2: { kalshi: defaultK, poly: defaultP }, B3: { kalshi: defaultK, poly: defaultP } };
      for (const bot of BOTS) {
        const first = sizesRows.find((r) => r.bot === bot);
        if (first) {
          nextBotSizes[bot] = {
            kalshi: first.size_kalshi != null ? String(first.size_kalshi) : defaultK,
            poly: first.size_polymarket != null ? String(first.size_polymarket) : defaultP,
          };
        }
      }
      setBotSizes(nextBotSizes);
      const cfg = configData as Config | null;
      setDelayEdits({
        b3: cfg?.b3_block_min != null ? String(cfg.b3_block_min) : '60',
        b2SpreadThreshold: cfg?.b2_high_spread_threshold_pct != null ? String(cfg.b2_high_spread_threshold_pct) : '0.55',
        b2HighSpread: cfg?.b2_high_spread_block_min != null ? String(cfg.b2_high_spread_block_min) : '15',
        b3EarlySpreadPct: cfg?.b3_early_high_spread_pct != null ? String(cfg.b3_early_high_spread_pct) : '1.8',
        b3EarlySpreadBlock: cfg?.b3_early_high_spread_block_min != null ? String(cfg.b3_early_high_spread_block_min) : '15',
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLoadError(msg);
    }
  }

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  // Auto-refresh so B123 Poly log and other data stay current (e.g. new losses visible)
  useEffect(() => {
    const interval = setInterval(() => load(), 90_000);
    return () => clearInterval(interval);
  }, []);

  async function setEmergencyOff(off: boolean) {
    setSaving(true);
    await getSupabase().from('bot_config').update({ emergency_off: off }).eq('id', 'default');
    await load();
    setSaving(false);
  }

  async function setB4EmergencyOff(off: boolean) {
    setSaving(true);
    await getSupabase().from('b4_state').update({ cooldown_until_ms: off ? 1 : 0, updated_at: new Date().toISOString() }).eq('id', 'default');
    await load();
    setSaving(false);
  }

  async function setB123cEmergencyOff(off: boolean) {
    setSaving(true);
    await getSupabase().from('b4_state').update({ b123c_cooldown_until_ms: off ? 1 : 0, updated_at: new Date().toISOString() }).eq('id', 'default');
    await load();
    setSaving(false);
  }

  async function saveB4TierConfig(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const config = {
      t1_spread: parseFloat(b4Config.t1_spread) || 0.10,
      t2_spread: parseFloat(b4Config.t2_spread) || 0.21,
      t3_spread: parseFloat(b4Config.t3_spread) || 0.45,
      t2_block_min: parseInt(b4Config.t2_block_min, 10) || 5,
      t3_blocks_t2_min: parseInt(b4Config.t3_blocks_t2_min, 10) || 15,
      t3_blocks_t1_min: parseInt(b4Config.t3_blocks_t1_min, 10) || 45,
      position_size: parseFloat(b4Config.position_size) || 5,
      b123c_position_size: parseFloat(b4Config.b123c_position_size) || 5,
      early_guard_spread_pct: parseFloat(b4Config.early_guard_spread_pct) || 0.6,
      early_guard_cooldown_min: parseInt(b4Config.early_guard_cooldown_min, 10) || 60,
      t1_mst_bump_pct: parseFloat(b4Config.t1_mst_bump_pct) || 0,
      t2_mst_bump_pct: parseFloat(b4Config.t2_mst_bump_pct) ?? 0.015,
    };
    await getSupabase().from('b4_state').update({
      results_json: config,
      updated_at: new Date().toISOString(),
    }).eq('id', 'default');
    await load();
    setSaving(false);
  }

  async function setB5EmergencyOff(off: boolean) {
    setSaving(true);
    await getSupabase().from('b5_state').update({ cooldown_until_ms: off ? 1 : 0, updated_at: new Date().toISOString() }).eq('id', 'default');
    await load();
    setSaving(false);
  }

  async function saveB5Config(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const config = {
      eth_t1_spread: parseFloat(b5Config.eth_t1_spread) || 0.32, eth_t2_spread: parseFloat(b5Config.eth_t2_spread) || 0.181, eth_t3_spread: parseFloat(b5Config.eth_t3_spread) || 0.110,
      sol_t1_spread: parseFloat(b5Config.sol_t1_spread) || 0.32, sol_t2_spread: parseFloat(b5Config.sol_t2_spread) || 0.206, sol_t3_spread: parseFloat(b5Config.sol_t3_spread) || 0.121,
      xrp_t1_spread: parseFloat(b5Config.xrp_t1_spread) || 0.32, xrp_t2_spread: parseFloat(b5Config.xrp_t2_spread) || 0.206, xrp_t3_spread: parseFloat(b5Config.xrp_t3_spread) || 0.121,
      t2_block_min: parseInt(b5Config.t2_block_min, 10) || 5, t3_blocks_t2_min: parseInt(b5Config.t3_blocks_t2_min, 10) || 15, t3_blocks_t1_min: parseInt(b5Config.t3_blocks_t1_min, 10) || 60, position_size: parseFloat(b5Config.position_size) || 5,
      early_guard_spread_pct: parseFloat(b5Config.early_guard_spread_pct) || 0.45, early_guard_cooldown_min: parseInt(b5Config.early_guard_cooldown_min, 10) || 60,
    };
    await getSupabase().from('b5_state').update({ results_json: config, updated_at: new Date().toISOString() }).eq('id', 'default');
    await load();
    setSaving(false);
  }

  async function clearB5Blocks() {
    if (!confirm('Clear T1/T2 blocks (all assets) and early-guard cooldown in DB? Restart B5 spread service on D3 for it to take effect.')) return;
    setSaving(true);
    const ts = new Date().toISOString();
    for (const asset of ['ETH', 'SOL', 'XRP']) {
      await getSupabase().from('b5_tier_blocks').upsert({ id: asset, t1_blocked_until_ms: 0, t2_blocked_until_ms: 0, updated_at: ts }, { onConflict: 'id' });
    }
    await getSupabase().from('b5_early_guard').upsert({ id: 'default', cooldown_until_ms: 0, updated_at: ts }, { onConflict: 'id' });
    await load();
    setSaving(false);
  }

  async function resetB5() {
    if (!confirm('Reset B5 bankroll and counters? This clears all B5 spread stats.')) return;
    setSaving(true);
    const config = {
      eth_t1_spread: parseFloat(b5Config.eth_t1_spread) || 0.32, eth_t2_spread: parseFloat(b5Config.eth_t2_spread) || 0.181, eth_t3_spread: parseFloat(b5Config.eth_t3_spread) || 0.110,
      sol_t1_spread: parseFloat(b5Config.sol_t1_spread) || 0.32, sol_t2_spread: parseFloat(b5Config.sol_t2_spread) || 0.206, sol_t3_spread: parseFloat(b5Config.sol_t3_spread) || 0.121,
      xrp_t1_spread: parseFloat(b5Config.xrp_t1_spread) || 0.32, xrp_t2_spread: parseFloat(b5Config.xrp_t2_spread) || 0.206, xrp_t3_spread: parseFloat(b5Config.xrp_t3_spread) || 0.121,
      t2_block_min: parseInt(b5Config.t2_block_min, 10) || 5, t3_blocks_t2_min: parseInt(b5Config.t3_blocks_t2_min, 10) || 15, t3_blocks_t1_min: parseInt(b5Config.t3_blocks_t1_min, 10) || 60, position_size: parseFloat(b5Config.position_size) || 5,
      early_guard_spread_pct: parseFloat(b5Config.early_guard_spread_pct) || 0.45, early_guard_cooldown_min: parseInt(b5Config.early_guard_cooldown_min, 10) || 60,
    };
    const startBankroll = 50;
    const today = new Date().toISOString().slice(0, 10);
    await getSupabase().from('b5_state').upsert({
      id: 'default',
      bankroll: startBankroll,
      max_bankroll: startBankroll,
      consecutive_losses: 0,
      cooldown_until_ms: 0,
      results_json: config,
      daily_start_bankroll: startBankroll,
      daily_start_date: today,
      half_kelly_trades_left: 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
    await load();
    setSaving(false);
  }

  async function resetB4() {
    if (!confirm('Reset B4 bankroll and counters? This clears all B4 stats.')) return;
    setSaving(true);
    const config = {
      t1_spread: parseFloat(b4Config.t1_spread) || 0.10,
      t2_spread: parseFloat(b4Config.t2_spread) || 0.21,
      t3_spread: parseFloat(b4Config.t3_spread) || 0.45,
      t2_block_min: parseInt(b4Config.t2_block_min, 10) || 5,
      t3_blocks_t2_min: parseInt(b4Config.t3_blocks_t2_min, 10) || 15,
      t3_blocks_t1_min: parseInt(b4Config.t3_blocks_t1_min, 10) || 45,
      position_size: parseFloat(b4Config.position_size) || 5,
      b123c_position_size: parseFloat(b4Config.b123c_position_size) || 5,
      early_guard_spread_pct: parseFloat(b4Config.early_guard_spread_pct) || 0.6,
      early_guard_cooldown_min: parseInt(b4Config.early_guard_cooldown_min, 10) || 60,
      t1_mst_bump_pct: parseFloat(b4Config.t1_mst_bump_pct) || 0,
      t2_mst_bump_pct: parseFloat(b4Config.t2_mst_bump_pct) ?? 0.015,
    };
    const startBankroll = 11;
    const today = new Date().toISOString().slice(0, 10);
    await getSupabase().from('b4_state').upsert({
      id: 'default',
      bankroll: startBankroll,
      max_bankroll: startBankroll,
      consecutive_losses: 0,
      cooldown_until_ms: 0,
      results_json: config,
      daily_start_bankroll: startBankroll,
      daily_start_date: today,
      half_kelly_trades_left: 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
    // Delete old B4 positions (momentum strategy data)
    await getSupabase().from('positions').delete().eq('bot', 'B4');
    await load();
    setSaving(false);
  }

  async function saveSizes(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    for (const bot of BOTS) {
      const k = parseFloat(botSizes[bot]?.kalshi ?? '');
      const p = parseFloat(botSizes[bot]?.poly ?? '');
      const sizeKalshi = Number.isNaN(k) ? null : k;
      const sizePoly = Number.isNaN(p) ? null : p;
      for (const asset of ASSETS) {
        await getSupabase().from('bot_position_sizes').upsert(
          { bot, asset, size_kalshi: sizeKalshi, size_polymarket: sizePoly },
          { onConflict: 'bot,asset' }
        );
      }
    }
    await load();
    setSaving(false);
  }

  async function saveDelays(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const b3 = parseInt(delayEdits.b3, 10);
    const b2SpreadThreshold = parseFloat(delayEdits.b2SpreadThreshold);
    const b2HighSpread = parseInt(delayEdits.b2HighSpread, 10);
    const b3EarlySpreadPct = parseFloat(delayEdits.b3EarlySpreadPct);
    const b3EarlySpreadBlock = parseInt(delayEdits.b3EarlySpreadBlock, 10);
    const updates: Record<string, number> = {};
    if (!Number.isNaN(b3) && b3 > 0) updates.b3_block_min = b3;
    if (!Number.isNaN(b2SpreadThreshold) && b2SpreadThreshold > 0) updates.b2_high_spread_threshold_pct = b2SpreadThreshold;
    if (!Number.isNaN(b2HighSpread) && b2HighSpread > 0) updates.b2_high_spread_block_min = b2HighSpread;
    if (!Number.isNaN(b3EarlySpreadPct) && b3EarlySpreadPct > 0) updates.b3_early_high_spread_pct = b3EarlySpreadPct;
    if (!Number.isNaN(b3EarlySpreadBlock) && b3EarlySpreadBlock > 0) updates.b3_early_high_spread_block_min = b3EarlySpreadBlock;
    if (Object.keys(updates).length > 0) {
      await getSupabase().from('bot_config').update(updates).eq('id', 'default');
    }
    await load();
    setSaving(false);
  }

  async function saveSpreadThresholds(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    for (const bot of BOTS) {
      for (const asset of ASSETS) {
        const key = `${bot}-${asset}`;
        const val = parseFloat(spreadEdits[key] ?? '');
        if (!Number.isNaN(val)) {
          await getSupabase().from('spread_thresholds').upsert(
            { bot, asset, threshold_pct: val },
            { onConflict: 'bot,asset' }
          );
        }
      }
    }
    await load();
    setSaving(false);
  }

  function escapeCsv(s: string): string {
    const t = String(s);
    if (t.includes(',') || t.includes('"') || t.includes('\n')) return `"${t.replace(/"/g, '""')}"`;
    return t;
  }

  /** Group B4 positions by (window, tier) so we only merge multiple fills of the same tier in the same window. */
  function groupB4ByWindow(positions: Position[]): Position[] {
    const byKey = new Map<string, Position[]>();
    for (const p of positions) {
      const slug = p.ticker_or_slug ?? p.id;
      const tier = String((p.raw as Record<string, unknown>)?.tier ?? 'B4');
      const key = `${slug}\n${tier}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(p);
    }
    const out: Position[] = [];
    for (const [, group] of byKey) {
      const first = group[0];
      const tier = String((first.raw as Record<string, unknown>)?.tier ?? 'B4');
      const hasLoss = group.some((p) => p.outcome === 'loss');
      const hasWin = group.some((p) => p.outcome === 'win');
      const outcome = hasLoss ? ('loss' as const) : hasWin ? ('win' as const) : (first.outcome ?? null);
      const resolvedAts = group.map((p) => p.resolved_at).filter(Boolean) as string[];
      const resolved_at = resolvedAts.length > 0 ? resolvedAts.sort().pop()! : (first.resolved_at ?? null);
      const totalSize = group.reduce((s, p) => s + (p.position_size ?? 0), 0);
      const earliest = group.reduce((a, b) => (a.entered_at < b.entered_at ? a : b));
      const raw: Position['raw'] = { ...(first.raw as Record<string, unknown>), tier } as Position['raw'];
      out.push({
        ...first,
        entered_at: earliest.entered_at,
        outcome,
        resolved_at: resolved_at ?? undefined,
        position_size: totalSize,
        raw,
      });
    }
    return out.sort((a, b) => new Date(b.entered_at).getTime() - new Date(a.entered_at).getTime());
  }

  const b4PositionsGrouped = groupB4ByWindow(b4Positions);

  const isKalshi = (v: string) => (v ?? '').toLowerCase() === 'kalshi';
  const isPolymarket = (v: string) => (v ?? '').toLowerCase() === 'polymarket';
  const isFilled = (o: string | null | undefined) => (o ?? '').toLowerCase() === 'win' || (o ?? '').toLowerCase() === 'loss';
  const positionsFilledKalshi = positions.filter((p) => isKalshi(p.venue) && isFilled(p.outcome)).slice(0, 200);
  // B1/B2/B3 Polymarket: 200 filled (win/loss) — used for table and win rate
  const b123PolyResolved = b123PolyFilled.filter((p) => p.outcome === 'win' || p.outcome === 'loss');
  const b123PolyWins = b123PolyResolved.filter((p) => p.outcome === 'win').length;
  const b123PolyLosses = b123PolyResolved.filter((p) => p.outcome === 'loss').length;
  const b123PolyWinRateResolved =
    b123PolyResolved.length > 0
      ? ((b123PolyWins / b123PolyResolved.length) * 100).toFixed(1)
      : null;
  const positionsPoly = [...b123PolyFilled].sort((a, b) => {
    const ra = a.resolved_at ? new Date(a.resolved_at).getTime() : 0;
    const rb = b.resolved_at ? new Date(b.resolved_at).getTime() : 0;
    if (rb !== ra) return rb - ra;
    return new Date(b.entered_at).getTime() - new Date(a.entered_at).getTime();
  });
  const positionsPendingNoFill = positions.filter((p) => !isFilled(p.outcome)).slice(0, 100);

  function downloadCsvFromList(list: Position[], filename: string) {
    setCsvLoading(true);
    const headers = ['entered_at', 'bot', 'asset', 'exchange', 'price_source', 'strike_spread_pct', 'position_size', 'ticker_or_slug', 'order_id', 'outcome', 'resolved_at'];
    const rows = list.map((p) =>
      [
        escapeCsv(p.entered_at),
        escapeCsv(p.bot),
        escapeCsv(p.asset),
        escapeCsv(p.venue),
        escapeCsv((p.raw as { price_source?: string })?.price_source ?? ''),
        escapeCsv(String(p.strike_spread_pct)),
        escapeCsv(String(p.position_size)),
        escapeCsv(p.ticker_or_slug ?? ''),
        escapeCsv(p.order_id ?? ''),
        escapeCsv(p.outcome ?? ''),
        escapeCsv(p.resolved_at ?? ''),
      ].join(',')
    );
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    setCsvLoading(false);
  }

  function downloadCsvKalshiFilled() {
    downloadCsvFromList(positionsFilledKalshi, `cursorbot-b123-kalshi-filled-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  function downloadCsvPoly() {
    downloadCsvFromList(positionsPoly, `cursorbot-b123-polymarket-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  function downloadB4Csv() {
    setB4CsvLoading(true);
    const headers = ['time', 'bot', 'asset', 'venue', 'price_source', 'spread_pct', 'size', 'tier', 'direction', 'outcome', 'resolved_at'];
    const rows = b4PositionsGrouped.map((p) => {
      const raw = (p.raw ?? {}) as Record<string, unknown>;
      return [
        escapeCsv(p.entered_at),
        escapeCsv(p.bot),
        escapeCsv(p.asset),
        escapeCsv(p.venue),
        escapeCsv(String(raw.price_source ?? '')),
        escapeCsv(String(p.strike_spread_pct)),
        escapeCsv(String(p.position_size)),
        escapeCsv(String(raw.tier ?? '')),
        escapeCsv(String(raw.direction ?? '')),
        escapeCsv(p.outcome ?? ''),
        escapeCsv(p.resolved_at ?? ''),
      ].join(',');
    });
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cursorbot-b4-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setB4CsvLoading(false);
  }

  function downloadB123cCsv() {
    setB123cCsvLoading(true);
    const list = [...b123cPositions].sort((a, b) => new Date(b.entered_at).getTime() - new Date(a.entered_at).getTime());
    const headers = ['entered_at', 'bot', 'asset', 'venue', 'price_source', 'strike_spread_pct', 'position_size', 'direction', 'ticker_or_slug', 'order_id', 'outcome', 'resolved_at'];
    const rows = list.map((p) => {
      const raw = (p.raw ?? {}) as Record<string, unknown>;
      return [
        escapeCsv(p.entered_at),
        escapeCsv(p.bot),
        escapeCsv(p.asset),
        escapeCsv(p.venue),
        escapeCsv(String(raw.price_source ?? 'chainlink')),
        escapeCsv(String(p.strike_spread_pct ?? '')),
        escapeCsv(String(p.position_size ?? '')),
        escapeCsv(String(raw.direction ?? '')),
        escapeCsv(p.ticker_or_slug ?? ''),
        escapeCsv(p.order_id ?? ''),
        escapeCsv(p.outcome ?? ''),
        escapeCsv(p.resolved_at ?? ''),
      ].join(',');
    });
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cursorbot-b123c-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setB123cCsvLoading(false);
  }

  function downloadB5Csv() {
    setB5CsvLoading(true);
    const headers = ['time', 'bot', 'asset', 'venue', 'price_source', 'spread_pct', 'size', 'tier', 'direction', 'outcome', 'resolved_at'];
    const rows = b5Positions.map((p) => {
      const raw = (p.raw ?? {}) as Record<string, unknown>;
      return [
        escapeCsv(p.entered_at),
        escapeCsv(p.bot),
        escapeCsv(p.asset),
        escapeCsv(p.venue),
        escapeCsv(String(raw.price_source ?? '')),
        escapeCsv(String(p.strike_spread_pct)),
        escapeCsv(String(p.position_size)),
        escapeCsv(String(raw.tier ?? '')),
        escapeCsv(String(raw.direction ?? '')),
        escapeCsv(p.outcome ?? ''),
        escapeCsv(p.resolved_at ?? ''),
      ].join(',');
    });
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cursorbot-b5-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setB5CsvLoading(false);
  }

  if (loading) return <p>Loading…</p>;

  if (loadError) {
    return (
      <div>
        <h1 style={headingStyle}>Cursorbot Control</h1>
        <p style={{ color: '#b91c1c', marginTop: 16 }}>
          Could not load data: {loadError}
        </p>
        <p style={{ fontSize: 14, color: '#666', marginTop: 8 }}>
          Check that <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> are set in Vercel, and that your Supabase project is not paused.
        </p>
        <button type="button" onClick={() => { setLoadError(null); setLoading(true); load().finally(() => setLoading(false)); }} style={{ marginTop: 12, ...buttonStyle }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      <h1 style={headingStyle}>Cursorbot Control</h1>

      <section style={{ marginBottom: 24 }}>
        <h2 style={headingStyle}>Emergency — B1 / B2 / B3</h2>
        <p>
          Status: <strong>{config?.emergency_off ? 'OFF (no new orders)' : 'Running'}</strong>
        </p>
        <button
          type="button"
          onClick={() => setEmergencyOff(true)}
          disabled={saving || config?.emergency_off}
          style={{ marginRight: 8, ...(saving || config?.emergency_off ? buttonDisabledStyle : buttonStyle) }}
        >
          Emergency OFF
        </button>
        <button
          type="button"
          onClick={() => setEmergencyOff(false)}
          disabled={saving || !config?.emergency_off}
          style={saving || !config?.emergency_off ? buttonDisabledStyle : buttonStyle}
        >
          Resume
        </button>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={headingStyle}>Position sizes (per bot)</h2>
        <form onSubmit={saveSizes}>
          <table style={{ borderCollapse: 'collapse', marginBottom: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '6px 8px' }}>Bot</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '6px 8px' }}>Kalshi</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '6px 8px' }}>Polymarket</th>
              </tr>
            </thead>
            <tbody>
              {BOTS.map((bot) => (
                <tr key={bot}>
                  <td style={{ borderBottom: '1px solid #ddd', padding: '6px 8px', fontWeight: 600 }}>{bot}</td>
                  <td style={{ borderBottom: '1px solid #ddd', padding: '6px 8px' }}>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={botSizes[bot]?.kalshi ?? ''}
                      onChange={(e) => setBotSizes((prev) => ({ ...prev, [bot]: { ...prev[bot], kalshi: e.target.value } }))}
                      style={{ width: 72, padding: '4px 6px' }}
                    />
                  </td>
                  <td style={{ borderBottom: '1px solid #ddd', padding: '6px 8px' }}>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={botSizes[bot]?.poly ?? ''}
                      onChange={(e) => setBotSizes((prev) => ({ ...prev, [bot]: { ...prev[bot], poly: e.target.value } }))}
                      style={{ width: 72, padding: '4px 6px' }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="submit" disabled={saving} style={saving ? buttonDisabledStyle : buttonStyle}>Save position sizes</button>
        </form>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={headingStyle}>Delays & B2 spread threshold</h2>
        <p style={{ fontSize: 14, color: '#666', marginBottom: 12 }}>
          B3 placed → blocks B1/B2 for <strong>b3_block_min</strong>. When B2 sees spread &gt; <strong>threshold</strong>%, B1 is blocked for <strong>b2_high_spread_block_min</strong>. B3 early: if spread &gt; <strong>b3_early_high_spread_pct</strong>% in first 7 min, skip B3 entry for <strong>b3_early_high_spread_block_min</strong>.
        </p>
        <form onSubmit={saveDelays}>
          <table style={{ borderCollapse: 'collapse', marginBottom: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '6px 8px' }}>Setting</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '6px 8px' }}>Value</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ borderBottom: '1px solid #ddd', padding: '6px 8px' }}>B3 blocks B1/B2 (min)</td>
                <td style={{ borderBottom: '1px solid #ddd', padding: '6px 8px' }}>
                  <input
                    type="number"
                    min="1"
                    value={delayEdits.b3}
                    onChange={(e) => setDelayEdits((prev) => ({ ...prev, b3: e.target.value }))}
                    style={{ width: 72, padding: '4px 6px' }}
                  />
                </td>
              </tr>
              <tr>
                <td style={{ borderBottom: '1px solid #ddd', padding: '6px 8px' }}>B2 spread threshold (%)</td>
                <td style={{ borderBottom: '1px solid #ddd', padding: '6px 8px' }}>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={delayEdits.b2SpreadThreshold}
                    onChange={(e) => setDelayEdits((prev) => ({ ...prev, b2SpreadThreshold: e.target.value }))}
                    style={{ width: 72, padding: '4px 6px' }}
                  />
                </td>
              </tr>
              <tr>
                <td style={{ borderBottom: '1px solid #ddd', padding: '6px 8px' }}>B2 spread &gt; threshold → block B1 (min)</td>
                <td style={{ borderBottom: '1px solid #ddd', padding: '6px 8px' }}>
                  <input
                    type="number"
                    min="1"
                    value={delayEdits.b2HighSpread}
                    onChange={(e) => setDelayEdits((prev) => ({ ...prev, b2HighSpread: e.target.value }))}
                    style={{ width: 72, padding: '4px 6px' }}
                  />
                </td>
              </tr>
              <tr>
                <td style={{ borderBottom: '1px solid #ddd', padding: '6px 8px' }}>B3 early spread threshold (%)</td>
                <td style={{ borderBottom: '1px solid #ddd', padding: '6px 8px' }}>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={delayEdits.b3EarlySpreadPct}
                    onChange={(e) => setDelayEdits((prev) => ({ ...prev, b3EarlySpreadPct: e.target.value }))}
                    style={{ width: 72, padding: '4px 6px' }}
                  />
                </td>
              </tr>
              <tr>
                <td style={{ borderBottom: '1px solid #ddd', padding: '6px 8px' }}>B3 early spread &gt; threshold → block B3 (min)</td>
                <td style={{ borderBottom: '1px solid #ddd', padding: '6px 8px' }}>
                  <input
                    type="number"
                    min="1"
                    value={delayEdits.b3EarlySpreadBlock}
                    onChange={(e) => setDelayEdits((prev) => ({ ...prev, b3EarlySpreadBlock: e.target.value }))}
                    style={{ width: 72, padding: '4px 6px' }}
                  />
                </td>
              </tr>
            </tbody>
          </table>
          <button type="submit" disabled={saving} style={saving ? buttonDisabledStyle : buttonStyle}>Save</button>
        </form>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={headingStyle}>Spread thresholds (%)</h2>
        <p style={{ fontSize: 14, color: '#666', marginBottom: 12 }}>Bot enters when spread is <strong>outside</strong> this % (e.g. 0.57 means enter if spread &gt; 0.57%).</p>
        <form onSubmit={saveSpreadThresholds}>
          <table style={{ borderCollapse: 'collapse', marginBottom: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '4px 8px' }}></th>
                {ASSETS.map((a) => (
                  <th key={a} style={{ borderBottom: '1px solid #ccc', padding: '4px 8px' }}>{a}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {BOTS.map((bot) => (
                <tr key={bot}>
                  <td style={{ borderBottom: '1px solid #eee', padding: '4px 8px', fontWeight: 600 }}>{bot}</td>
                  {ASSETS.map((asset) => (
                    <td key={asset} style={{ borderBottom: '1px solid #eee', padding: '4px 8px' }}>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={spreadEdits[`${bot}-${asset}`] ?? ''}
                        onChange={(e) => setSpreadEdits((prev) => ({ ...prev, [`${bot}-${asset}`]: e.target.value }))}
                        style={{ width: 64 }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <button type="submit" disabled={saving} style={saving ? buttonDisabledStyle : buttonStyle}>Save spread thresholds</button>
        </form>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={headingStyle}>Recent errors</h2>
        <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
          Errors mentioning <strong>No Chainlink price</strong> mean the bot could not get a price and skipped orders (B4/B123c retry up to 2 min then reset).
        </p>
        {errors.length === 0 ? (
          <p style={{ color: '#666' }}>No errors logged.</p>
        ) : (
          <table style={{ width: '100%', maxWidth: 720, borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', width: 120 }}>Time</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Message</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Context</th>
              </tr>
            </thead>
            <tbody>
              {errors.map((e) => {
                const isNoChainlink = e.message?.toLowerCase().includes('no chainlink');
                return (
                  <tr key={e.id}>
                    <td style={{ borderBottom: '1px solid #eee', whiteSpace: 'nowrap' }}>{formatMst(e.created_at, true)}</td>
                    <td style={{ borderBottom: '1px solid #eee', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: isNoChainlink ? '#b91c1c' : undefined }} title={e.message}>{e.message}</td>
                    <td style={{ borderBottom: '1px solid #eee', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.context ? JSON.stringify(e.context) : undefined}>{e.context ? JSON.stringify(e.context) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={headingStyle}>Polymarket skips (last 50)</h2>
        <p style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>
          When Polymarket did not place an order. <code>Kalshi placed</code> = yes if Kalshi placed for same bot/asset.
        </p>
        {polySkips.length === 0 ? (
          <p style={{ color: '#666' }}>No Polymarket skips logged.</p>
        ) : (
          <table style={{ width: '100%', maxWidth: 720, borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', width: 120 }}>Time</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', width: 48 }}>Bot</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', width: 56 }}>Asset</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', width: 80 }}>Kalshi placed</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {polySkips.map((s) => (
                <tr key={s.id}>
                  <td style={{ borderBottom: '1px solid #eee', whiteSpace: 'nowrap' }}>{formatMst(s.created_at, true)}</td>
                  <td style={{ borderBottom: '1px solid #eee' }}>{s.bot}</td>
                  <td style={{ borderBottom: '1px solid #eee' }}>{s.asset}</td>
                  <td style={{ borderBottom: '1px solid #eee' }}>{s.kalshi_placed ? 'yes' : 'no'}</td>
                  <td style={{ borderBottom: '1px solid #eee' }}>{s.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={headingStyle}>Win rate (resolved)</h2>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 16 }}>
          <div style={{ padding: '12px 16px', border: '1px solid #444', borderRadius: 8, background: '#111', color: '#e5e5e5' }}>
            <strong>B1/B2/B3 Kalshi</strong> (last 200 filled):{' '}
            {(() => {
              const kalshiResolved = positionsFilledKalshi;
              const wins = kalshiResolved.filter((p) => p.outcome === 'win').length;
              const n = kalshiResolved.length;
              if (n === 0) return <span style={{ color: '#888' }}>no resolved yet</span>;
              return <><strong style={{ color: '#22c55e' }}>{wins}</strong> / {n} ({((wins / n) * 100).toFixed(1)}%)</>;
            })()}
          </div>
          <div style={{ padding: '12px 16px', border: '1px solid #444', borderRadius: 8, background: '#111', color: '#e5e5e5' }}>
            <strong>B4</strong> (last 200 filled):{' '}
            {(() => {
              const resolved = b4Positions;
              const wins = resolved.filter((p) => p.outcome === 'win').length;
              const n = resolved.length;
              if (n === 0) return <span style={{ color: '#888' }}>no resolved yet</span>;
              return <><strong style={{ color: '#22c55e' }}>{wins}</strong> / {n} ({((wins / n) * 100).toFixed(1)}%)</>;
            })()}
          </div>
          <div style={{ padding: '12px 16px', border: '1px solid #444', borderRadius: 8, background: '#111', color: '#e5e5e5' }}>
            <strong>B1c/B2c/B3c</strong> (last 200 filled):{' '}
            {(() => {
              const resolved = b123cPositions;
              const wins = resolved.filter((p) => p.outcome === 'win').length;
              const n = resolved.length;
              if (n === 0) return <span style={{ color: '#888' }}>no resolved yet</span>;
              return <><strong style={{ color: '#22c55e' }}>{wins}</strong> / {n} ({((wins / n) * 100).toFixed(1)}%)</>;
            })()}
          </div>
          <div style={{ padding: '12px 16px', border: '1px solid #444', borderRadius: 8, background: '#111', color: '#e5e5e5' }}>
            <strong>B1/B2/B3 Polymarket</strong> (last 200 filled):{' '}
            {b123PolyResolved.length === 0 ? (
              <span style={{ color: '#888' }}>no resolved yet</span>
            ) : (
              <><strong style={{ color: '#22c55e' }}>{b123PolyWins}</strong> / {b123PolyResolved.length} ({b123PolyWinRateResolved}%)</>
            )}
          </div>
          <div style={{ padding: '12px 16px', border: '1px solid #444', borderRadius: 8, background: '#111', color: '#e5e5e5' }}>
            <strong>B5</strong> (last 200 filled):{' '}
            {(() => {
              const resolved = b5Positions;
              const wins = resolved.filter((p) => p.outcome === 'win').length;
              const n = resolved.length;
              if (n === 0) return <span style={{ color: '#888' }}>no resolved yet</span>;
              return <><strong style={{ color: '#22c55e' }}>{wins}</strong> / {n} ({((wins / n) * 100).toFixed(1)}%)</>;
            })()}
          </div>
        </div>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={headingStyle}>B4 — 5-Minute BTC Spread Bot</h2>

        <div style={{ marginBottom: 16, padding: 12, border: '1px solid #444', borderRadius: 8, background: '#111', color: '#e5e5e5' }}>
          <p style={{ margin: 0, marginBottom: 8, color: '#e5e5e5' }}>
            B4 Status: <strong style={{ color: b4State?.cooldown_until_ms === 1 ? '#ef4444' : '#22c55e' }}>{b4State?.cooldown_until_ms === 1 ? 'OFF (paused)' : 'Running'}</strong>
            {' · '}
            B123c Status: <strong style={{ color: (b4State?.b123c_cooldown_until_ms ?? 0) === 1 ? '#ef4444' : '#22c55e' }}>{(b4State?.b123c_cooldown_until_ms ?? 0) === 1 ? 'OFF (paused)' : 'Running'}</strong>
          </p>
          <button
            type="button"
            onClick={() => setB4EmergencyOff(true)}
            disabled={saving || b4State?.cooldown_until_ms === 1}
            style={{ marginRight: 8, ...(saving || b4State?.cooldown_until_ms === 1 ? buttonDisabledStyle : { ...buttonStyle, background: '#dc2626' }) }}
          >
            Pause B4
          </button>
          <button
            type="button"
            onClick={() => setB4EmergencyOff(false)}
            disabled={saving || b4State?.cooldown_until_ms !== 1}
            style={{ marginRight: 8, ...(saving || b4State?.cooldown_until_ms !== 1 ? buttonDisabledStyle : { ...buttonStyle, background: '#16a34a' }) }}
          >
            Resume B4
          </button>
          <span style={{ marginLeft: 16, marginRight: 8, color: '#666' }}>|</span>
          <span style={{ marginRight: 8, color: '#e5e5e5' }}>B123c:</span>
          <button
            type="button"
            onClick={() => setB123cEmergencyOff(true)}
            disabled={saving || b4State?.b123c_cooldown_until_ms === 1}
            style={{ marginRight: 8, ...(saving || b4State?.b123c_cooldown_until_ms === 1 ? buttonDisabledStyle : { ...buttonStyle, background: '#dc2626' }) }}
          >
            Pause B123c
          </button>
          <button
            type="button"
            onClick={() => setB123cEmergencyOff(false)}
            disabled={saving || b4State?.b123c_cooldown_until_ms !== 1}
            style={{ marginRight: 8, ...(saving || b4State?.b123c_cooldown_until_ms !== 1 ? buttonDisabledStyle : { ...buttonStyle, background: '#16a34a' }) }}
          >
            Resume B123c
          </button>
          <button
            type="button"
            onClick={resetB4}
            disabled={saving}
            style={{ ...buttonStyle, background: '#7c3aed' }}
          >
            Reset B4
          </button>
          {b4State && (
            <span style={{ marginLeft: 12, fontSize: 13, color: '#aaa' }}>
              Bankroll: <strong style={{ color: '#0D9488' }}>${Number(b4State.bankroll).toFixed(2)}</strong>
              {' | '}Trades: {b4PositionsGrouped.length}
              {b4State.updated_at && <> | Last: {formatMst(b4State.updated_at, true)}</>}
            </span>
          )}
        </div>

        <div style={{ marginBottom: 16, padding: 12, border: '1px solid #444', borderRadius: 8, background: '#111', color: '#e5e5e5' }}>
          <h3 style={{ ...headingStyle, margin: '0 0 12px', fontSize: 16, color: '#fff' }}>B4 Spread Tier Config</h3>
          <p style={{ fontSize: 13, color: '#ccc', marginBottom: 12 }}>
            T1: last 50s, T2: last 100s (blocks T1), T3: last 160s (blocks T2 and T1 separately). Saved to Supabase, picked up by bot within ~1h.
          </p>
          <form onSubmit={saveB4TierConfig}>
            <table style={{ borderCollapse: 'collapse', marginBottom: 12 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid #555', padding: '4px 8px', color: '#fff' }}>Setting</th>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid #555', padding: '4px 8px', color: '#fff' }}>Value</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px', color: '#e5e5e5' }}>T1 spread threshold (%)</td>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px' }}>
                    <input type="number" step="any" min="0" value={b4Config.t1_spread} onChange={(e) => setB4Config((p) => ({ ...p, t1_spread: e.target.value }))} style={{ width: 72, padding: '4px 6px' }} />
                  </td>
                </tr>
                <tr>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px', color: '#e5e5e5' }}>T2 spread threshold (%)</td>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px' }}>
                    <input type="number" step="any" min="0" value={b4Config.t2_spread} onChange={(e) => setB4Config((p) => ({ ...p, t2_spread: e.target.value }))} style={{ width: 72, padding: '4px 6px' }} />
                  </td>
                </tr>
                <tr>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px', color: '#e5e5e5' }}>T3 spread threshold (%)</td>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px' }}>
                    <input type="number" step="any" min="0" value={b4Config.t3_spread} onChange={(e) => setB4Config((p) => ({ ...p, t3_spread: e.target.value }))} style={{ width: 72, padding: '4px 6px' }} />
                  </td>
                </tr>
                <tr>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px', color: '#e5e5e5' }}>T2 → blocks T1 (min)</td>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px' }}>
                    <input type="number" min="1" value={b4Config.t2_block_min} onChange={(e) => setB4Config((p) => ({ ...p, t2_block_min: e.target.value }))} style={{ width: 72, padding: '4px 6px' }} />
                  </td>
                </tr>
                <tr>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px', color: '#e5e5e5' }}>T3 → blocks T2 (min)</td>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px' }}>
                    <input type="number" min="1" value={b4Config.t3_blocks_t2_min} onChange={(e) => setB4Config((p) => ({ ...p, t3_blocks_t2_min: e.target.value }))} style={{ width: 72, padding: '4px 6px' }} />
                  </td>
                </tr>
                <tr>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px', color: '#e5e5e5' }}>T3 → blocks T1 (min)</td>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px' }}>
                    <input type="number" min="1" value={b4Config.t3_blocks_t1_min} onChange={(e) => setB4Config((p) => ({ ...p, t3_blocks_t1_min: e.target.value }))} style={{ width: 72, padding: '4px 6px' }} />
                  </td>
                </tr>
                <tr>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px', color: '#e5e5e5' }}>B4 position size ($)</td>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px' }}>
                    <input type="number" step="any" min="1" value={b4Config.position_size} onChange={(e) => setB4Config((p) => ({ ...p, position_size: e.target.value }))} style={{ width: 72, padding: '4px 6px' }} />
                  </td>
                </tr>
                <tr>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px', color: '#e5e5e5' }}>B1c/B2c/B3c position size ($)</td>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px' }}>
                    <input type="number" step="any" min="1" value={b4Config.b123c_position_size} onChange={(e) => setB4Config((p) => ({ ...p, b123c_position_size: e.target.value }))} style={{ width: 72, padding: '4px 6px' }} />
                  </td>
                </tr>
                <tr>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px', color: '#e5e5e5' }}>Early guard spread threshold (%)</td>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px' }}>
                    <input type="number" step="any" min="0" value={b4Config.early_guard_spread_pct} onChange={(e) => setB4Config((p) => ({ ...p, early_guard_spread_pct: e.target.value }))} style={{ width: 72, padding: '4px 6px' }} />
                  </td>
                </tr>
                <tr>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px', color: '#e5e5e5' }}>Early guard cooldown (min)</td>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px' }}>
                    <input type="number" min="1" value={b4Config.early_guard_cooldown_min} onChange={(e) => setB4Config((p) => ({ ...p, early_guard_cooldown_min: e.target.value }))} style={{ width: 72, padding: '4px 6px' }} />
                  </td>
                </tr>
                <tr>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px', color: '#e5e5e5' }}>T1 add during Mon–Fri 7–11am MST (%)</td>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px' }}>
                    <input type="number" step="any" min="0" value={b4Config.t1_mst_bump_pct} onChange={(e) => setB4Config((p) => ({ ...p, t1_mst_bump_pct: e.target.value }))} style={{ width: 72, padding: '4px 6px' }} />
                    <span style={{ marginLeft: 6, fontSize: 12, color: '#888' }}>0 = off</span>
                  </td>
                </tr>
                <tr>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px', color: '#e5e5e5' }}>T2 add during Mon–Fri 7–11am MST (%)</td>
                  <td style={{ borderBottom: '1px solid #333', padding: '4px 8px' }}>
                    <input type="number" step="any" min="0" value={b4Config.t2_mst_bump_pct} onChange={(e) => setB4Config((p) => ({ ...p, t2_mst_bump_pct: e.target.value }))} style={{ width: 72, padding: '4px 6px' }} />
                    <span style={{ marginLeft: 6, fontSize: 12, color: '#888' }}>0 = off</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <button type="submit" disabled={saving} style={saving ? buttonDisabledStyle : buttonStyle}>Save B4 config</button>
          </form>
        </div>

        <p style={{ marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: '#666' }}>B4 trades (last 200 filled).</span>
          <button type="button" onClick={downloadB4Csv} disabled={b4CsvLoading} style={{ ...buttonStyle, marginLeft: 12 }}>{b4CsvLoading ? 'Preparing…' : 'Download B4 CSV'}</button>
        </p>
        {b4PositionsGrouped.length === 0 ? (
          <p style={{ color: '#666' }}>No B4 trades yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Time</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Bot</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Asset</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Venue</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Price src</th>
                <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>Spread %</th>
                <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>Size</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Result</th>
              </tr>
            </thead>
            <tbody>
              {b4PositionsGrouped.map((p) => {
                const raw = (p.raw ?? {}) as Record<string, unknown>;
                const tier = String(raw.tier ?? 'B4');
                const result = p.outcome === 'win' ? 'Win' : p.outcome === 'loss' ? 'Loss' : 'Pending';
                const resultColor = p.outcome === 'win' ? '#22c55e' : p.outcome === 'loss' ? '#ef4444' : '#888';
                return (
                  <tr key={p.id}>
                    <td style={{ borderBottom: '1px solid #eee', whiteSpace: 'nowrap' }}>{formatMst(p.entered_at, true)}</td>
                    <td style={{ borderBottom: '1px solid #eee' }}>{tier}</td>
                    <td style={{ borderBottom: '1px solid #eee' }}>{p.asset}</td>
                    <td style={{ borderBottom: '1px solid #eee' }}>{p.venue}</td>
                    <td style={{ borderBottom: '1px solid #eee' }}>{String(raw.price_source ?? '—')}</td>
                    <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>{p.strike_spread_pct?.toFixed(3)}</td>
                    <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>{p.position_size}</td>
                    <td style={{ borderBottom: '1px solid #eee', color: resultColor, fontWeight: result !== 'Pending' ? 600 : undefined }}>{result}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <p style={{ marginTop: 24, marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: '#666' }}>B4 placed but not filled (last 100).</span>
        </p>
        {b4Unfilled.length === 0 ? (
          <p style={{ color: '#666' }}>No B4 no-fill orders in the last 100.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Time</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Tier</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Asset</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Venue</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Price src</th>
                <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>Spread %</th>
                <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>Size</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Slug</th>
              </tr>
            </thead>
            <tbody>
              {b4Unfilled.map((p) => {
                const raw = (p.raw ?? {}) as Record<string, unknown>;
                const tier = String(raw.tier ?? 'B4');
                return (
                  <tr key={p.id}>
                    <td style={{ borderBottom: '1px solid #eee', whiteSpace: 'nowrap' }}>{formatMst(p.entered_at, true)}</td>
                    <td style={{ borderBottom: '1px solid #eee' }}>{tier}</td>
                    <td style={{ borderBottom: '1px solid #eee' }}>{p.asset}</td>
                    <td style={{ borderBottom: '1px solid #eee' }}>{p.venue}</td>
                    <td style={{ borderBottom: '1px solid #eee' }}>{String(raw.price_source ?? '—')}</td>
                    <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>{p.strike_spread_pct != null ? p.strike_spread_pct.toFixed(3) : '—'}</td>
                    <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>{p.position_size}</td>
                    <td style={{ borderBottom: '1px solid #eee', fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.ticker_or_slug ?? ''}>{p.ticker_or_slug ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={headingStyle}>B1c / B2c / B3c — Chainlink Clone (last 200 filled)</h2>
        <p style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>
          Chainlink-only clone of B1/B2/B3 on the B4 droplet. Uses same spread thresholds and blocking rules. B4 and B123c have separate Pause/Resume buttons above.
        </p>
        <p style={{ marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: '#666' }}>B1c / B2c / B3c trades (last 200 filled).</span>
          <button type="button" onClick={downloadB123cCsv} disabled={b123cCsvLoading} style={{ ...buttonStyle, marginLeft: 12 }}>{b123cCsvLoading ? 'Preparing…' : 'Download B1/2/3c CSV'}</button>
        </p>
        {b123cPositions.length === 0 ? (
          <p style={{ color: '#666' }}>No B1c/B2c/B3c trades yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Time</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Bot</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Asset</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Venue</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Price src</th>
                <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>Spread %</th>
                <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>Size</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Result</th>
              </tr>
            </thead>
            <tbody>
              {b123cPositions.map((p) => {
                const raw = (p.raw ?? {}) as Record<string, unknown>;
                const result = p.outcome === 'win' ? 'Win' : p.outcome === 'loss' ? 'Loss' : 'Pending';
                const resultColor = p.outcome === 'win' ? '#22c55e' : p.outcome === 'loss' ? '#ef4444' : '#888';
                return (
                  <tr key={p.id}>
                    <td style={{ borderBottom: '1px solid #eee', whiteSpace: 'nowrap' }}>{formatMst(p.entered_at, true)}</td>
                    <td style={{ borderBottom: '1px solid #eee' }}>{p.bot}</td>
                    <td style={{ borderBottom: '1px solid #eee' }}>{p.asset}</td>
                    <td style={{ borderBottom: '1px solid #eee' }}>{p.venue}</td>
                    <td style={{ borderBottom: '1px solid #eee' }}>{String(raw.price_source ?? '—')}</td>
                    <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>{p.strike_spread_pct?.toFixed(3)}</td>
                    <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>{p.position_size}</td>
                    <td style={{ borderBottom: '1px solid #eee', color: resultColor, fontWeight: result !== 'Pending' ? 600 : undefined }}>{result}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={headingStyle}>B1c / B2c / B3c — Unfilled / no-fill (last 100)</h2>
        <p style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>
          Limit orders that were placed but not filled (outcome = No fill) or not yet resolved (Pending). Useful for debugging balance/allowance or fill rate.
        </p>
        {b123cUnfilled.length === 0 ? (
          <p style={{ color: '#666' }}>No unfilled B1c/B2c/B3c orders in the last 100.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Time</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Bot</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Asset</th>
                <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>Spread % at entry</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Order ID</th>
                <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>Size</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {b123cUnfilled.map((p) => {
                const outcomeLabel = p.outcome === 'no_fill' ? 'No fill' : p.outcome === 'win' ? 'Win' : p.outcome === 'loss' ? 'Loss' : 'Pending';
                const outcomeColor = p.outcome === 'no_fill' ? '#f59e0b' : p.outcome === 'win' ? '#22c55e' : p.outcome === 'loss' ? '#ef4444' : '#888';
                return (
                  <tr key={p.id}>
                    <td style={{ borderBottom: '1px solid #eee', whiteSpace: 'nowrap' }}>{formatMst(p.entered_at, true)}</td>
                    <td style={{ borderBottom: '1px solid #eee' }}>{p.bot}</td>
                    <td style={{ borderBottom: '1px solid #eee' }}>{p.asset}</td>
                    <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>{p.strike_spread_pct != null ? `${Number(p.strike_spread_pct).toFixed(3)}%` : '—'}</td>
                    <td style={{ borderBottom: '1px solid #eee', fontSize: 11, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.order_id ?? ''}>{p.order_id ?? '—'}</td>
                    <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>{p.position_size}</td>
                    <td style={{ borderBottom: '1px solid #eee', color: outcomeColor, fontWeight: p.outcome ? 600 : undefined }}>{outcomeLabel}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2 style={headingStyle}>B1/B2/B3 – Kalshi filled (last 200)</h2>
        <p style={{ marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: '#666' }}>Kalshi orders that <strong>filled</strong> (win or loss).</span>
          <button type="button" onClick={downloadCsvKalshiFilled} disabled={csvLoading} style={{ ...buttonStyle, marginLeft: 12 }}>{csvLoading ? 'Preparing…' : 'Download CSV (last 200)'}</button>
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Time</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Bot</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Asset</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Price src</th>
              <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>Spread %</th>
              <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>Size</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Result</th>
            </tr>
          </thead>
          <tbody>
            {positionsFilledKalshi.map((p) => {
              const result = p.outcome === 'win' ? 'Win' : p.outcome === 'loss' ? 'Loss' : '—';
              const resultColor = p.outcome === 'win' ? '#22c55e' : '#ef4444';
              return (
                <tr key={p.id}>
                  <td style={{ borderBottom: '1px solid #eee' }}>{formatMst(p.entered_at, true)}</td>
                  <td style={{ borderBottom: '1px solid #eee' }}>{p.bot}</td>
                  <td style={{ borderBottom: '1px solid #eee' }}>{p.asset}</td>
                  <td style={{ borderBottom: '1px solid #eee' }}>{(p.raw as { price_source?: string })?.price_source ?? '—'}</td>
                  <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>{p.strike_spread_pct?.toFixed(3)}</td>
                  <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>{p.position_size}</td>
                  <td style={{ borderBottom: '1px solid #eee', color: resultColor }}>{result}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <h2 style={headingStyle}>B1/B2/B3 – Polymarket (last 200 filled)</h2>
        <p style={{ marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: '#666' }}>Polymarket orders (win/loss) sorted by time. B1/B2/B3 Poly are placed from D1; Win/Loss appear once the resolver has run (every ~10 min). Page auto-refreshes every 90s.</span>
          <button type="button" onClick={downloadCsvPoly} disabled={csvLoading} style={{ ...buttonStyle, marginLeft: 12 }}>{csvLoading ? 'Preparing…' : 'Download CSV'}</button>
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Time</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Bot</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Asset</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Price src</th>
              <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>Spread %</th>
              <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>Size</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Result</th>
            </tr>
          </thead>
          <tbody>
            {positionsPoly.map((p) => {
              const result = p.outcome === 'win' ? 'Win' : p.outcome === 'loss' ? 'Loss' : p.outcome === 'no_fill' ? 'No fill' : 'Pending';
              const resultColor = p.outcome === 'win' ? '#22c55e' : p.outcome === 'loss' ? '#ef4444' : '#888';
              return (
                <tr key={p.id}>
                  <td style={{ borderBottom: '1px solid #eee' }}>{formatMst(p.entered_at, true)}</td>
                  <td style={{ borderBottom: '1px solid #eee' }}>{p.bot}</td>
                  <td style={{ borderBottom: '1px solid #eee' }}>{p.asset}</td>
                  <td style={{ borderBottom: '1px solid #eee' }}>{(p.raw as { price_source?: string })?.price_source ?? '—'}</td>
                  <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>{p.strike_spread_pct?.toFixed(3)}</td>
                  <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>{p.position_size}</td>
                  <td style={{ borderBottom: '1px solid #eee', color: resultColor }}>{result}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <h2 style={headingStyle}>B1/B2/B3 – Pending / no fill (last 100)</h2>
        <p style={{ marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: '#666' }}>Orders not yet filled (pending or no fill) from both Kalshi and Polymarket. No CSV download.</span>
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Time</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Bot</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Asset</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Venue</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Price src</th>
              <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>Spread %</th>
              <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>Size</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Result</th>
            </tr>
          </thead>
          <tbody>
            {positionsPendingNoFill.map((p) => {
              const result = p.outcome === 'no_fill' ? 'No fill' : 'Pending';
              return (
                <tr key={p.id}>
                  <td style={{ borderBottom: '1px solid #eee' }}>{formatMst(p.entered_at, true)}</td>
                  <td style={{ borderBottom: '1px solid #eee' }}>{p.bot}</td>
                  <td style={{ borderBottom: '1px solid #eee' }}>{p.asset}</td>
                  <td style={{ borderBottom: '1px solid #eee' }}>{p.venue}</td>
                  <td style={{ borderBottom: '1px solid #eee' }}>{(p.raw as { price_source?: string })?.price_source ?? '—'}</td>
                  <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>{p.strike_spread_pct?.toFixed(3)}</td>
                  <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>{p.position_size}</td>
                  <td style={{ borderBottom: '1px solid #eee', color: '#888' }}>{result}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={headingStyle}>B5 — 5-Minute ETH/SOL/XRP (D3)</h2>
        <div style={{ marginBottom: 16, padding: 12, border: '1px solid #444', borderRadius: 8, background: '#111', color: '#e5e5e5' }}>
          <p style={{ margin: 0, marginBottom: 8, color: '#e5e5e5' }}>
            B5 Status: <strong style={{ color: b5State?.cooldown_until_ms === 1 ? '#ef4444' : '#22c55e' }}>{b5State?.cooldown_until_ms === 1 ? 'OFF (paused)' : 'Running'}</strong>
          </p>
          <button type="button" onClick={() => setB5EmergencyOff(true)} disabled={saving || b5State?.cooldown_until_ms === 1} style={{ marginRight: 8, ...(saving || b5State?.cooldown_until_ms === 1 ? buttonDisabledStyle : { ...buttonStyle, background: '#dc2626' }) }}>Pause B5</button>
          <button type="button" onClick={() => setB5EmergencyOff(false)} disabled={saving || b5State?.cooldown_until_ms !== 1} style={{ marginRight: 8, ...(saving || b5State?.cooldown_until_ms !== 1 ? buttonDisabledStyle : { ...buttonStyle, background: '#16a34a' }) }}>Resume B5</button>
          <button type="button" onClick={resetB5} disabled={saving} style={{ ...buttonStyle, background: '#7c3aed' }}>Reset B5</button>
          <button type="button" onClick={clearB5Blocks} disabled={saving} style={{ ...buttonStyle, background: '#ca8a04' }} title="Clear T1/T2 blocks in DB. Restart B5 spread on D3 to take effect.">Clear B5 blocks</button>
          {b5State && (
            <span style={{ marginLeft: 12, fontSize: 13, color: '#aaa' }}>
              Bankroll: <strong style={{ color: '#0D9488' }}>${Number(b5State.bankroll).toFixed(2)}</strong>
              {' | '}Trades: {b5Positions.length}
              {b5State.updated_at && <> | Last: {formatMst(b5State.updated_at, true)}</>}
            </span>
          )}
        </div>
        <div style={{ marginBottom: 16, padding: 12, border: '1px solid #444', borderRadius: 8, background: '#111', color: '#e5e5e5' }}>
          <h3 style={{ ...headingStyle, margin: '0 0 12px', fontSize: 16, color: '#fff' }}>B5 Spread Tier Config</h3>
          <p style={{ fontSize: 13, color: '#ccc', marginBottom: 12 }}>Per-asset tier spreads (%). T1 = lowest spread (enters last 50s), T3 = highest spread (enters first, blocks T2 and T1 separately per asset). Order: T3 / T2 / T1. One position size for all.</p>
          <form onSubmit={saveB5Config}>
            <table style={{ borderCollapse: 'collapse', marginBottom: 12 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid #555', padding: '4px 8px', color: '#fff' }}>Setting</th>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid #555', padding: '4px 8px', color: '#fff' }}>Value</th>
                </tr>
              </thead>
              <tbody>
                <tr><td style={{ borderBottom: '1px solid #333', padding: '4px 8px', color: '#e5e5e5' }}>ETH T3 / T2 / T1 (%)</td><td style={{ borderBottom: '1px solid #333', padding: '4px 8px' }}><input type="number" step="any" min="0" value={b5Config.eth_t1_spread} onChange={(e) => setB5Config((p) => ({ ...p, eth_t1_spread: e.target.value }))} style={{ width: 56, padding: '4px 6px', marginRight: 4 }} /><input type="number" step="any" min="0" value={b5Config.eth_t2_spread} onChange={(e) => setB5Config((p) => ({ ...p, eth_t2_spread: e.target.value }))} style={{ width: 56, padding: '4px 6px', marginRight: 4 }} /><input type="number" step="any" min="0" value={b5Config.eth_t3_spread} onChange={(e) => setB5Config((p) => ({ ...p, eth_t3_spread: e.target.value }))} style={{ width: 56, padding: '4px 6px' }} /></td></tr>
                <tr><td style={{ borderBottom: '1px solid #333', padding: '4px 8px', color: '#e5e5e5' }}>SOL T3 / T2 / T1 (%)</td><td style={{ borderBottom: '1px solid #333', padding: '4px 8px' }}><input type="number" step="any" min="0" value={b5Config.sol_t1_spread} onChange={(e) => setB5Config((p) => ({ ...p, sol_t1_spread: e.target.value }))} style={{ width: 56, padding: '4px 6px', marginRight: 4 }} /><input type="number" step="any" min="0" value={b5Config.sol_t2_spread} onChange={(e) => setB5Config((p) => ({ ...p, sol_t2_spread: e.target.value }))} style={{ width: 56, padding: '4px 6px', marginRight: 4 }} /><input type="number" step="any" min="0" value={b5Config.sol_t3_spread} onChange={(e) => setB5Config((p) => ({ ...p, sol_t3_spread: e.target.value }))} style={{ width: 56, padding: '4px 6px' }} /></td></tr>
                <tr><td style={{ borderBottom: '1px solid #333', padding: '4px 8px', color: '#e5e5e5' }}>XRP T3 / T2 / T1 (%)</td><td style={{ borderBottom: '1px solid #333', padding: '4px 8px' }}><input type="number" step="any" min="0" value={b5Config.xrp_t1_spread} onChange={(e) => setB5Config((p) => ({ ...p, xrp_t1_spread: e.target.value }))} style={{ width: 56, padding: '4px 6px', marginRight: 4 }} /><input type="number" step="any" min="0" value={b5Config.xrp_t2_spread} onChange={(e) => setB5Config((p) => ({ ...p, xrp_t2_spread: e.target.value }))} style={{ width: 56, padding: '4px 6px', marginRight: 4 }} /><input type="number" step="any" min="0" value={b5Config.xrp_t3_spread} onChange={(e) => setB5Config((p) => ({ ...p, xrp_t3_spread: e.target.value }))} style={{ width: 56, padding: '4px 6px' }} /></td></tr>
                <tr><td style={{ borderBottom: '1px solid #333', padding: '4px 8px', color: '#e5e5e5' }}>T2 → blocks T1 (min)</td><td style={{ borderBottom: '1px solid #333', padding: '4px 8px' }}><input type="number" min="1" value={b5Config.t2_block_min} onChange={(e) => setB5Config((p) => ({ ...p, t2_block_min: e.target.value }))} style={{ width: 72, padding: '4px 6px' }} /></td></tr>
                <tr><td style={{ borderBottom: '1px solid #333', padding: '4px 8px', color: '#e5e5e5' }}>T3 → blocks T2 (min)</td><td style={{ borderBottom: '1px solid #333', padding: '4px 8px' }}><input type="number" min="1" value={b5Config.t3_blocks_t2_min} onChange={(e) => setB5Config((p) => ({ ...p, t3_blocks_t2_min: e.target.value }))} style={{ width: 72, padding: '4px 6px' }} /></td></tr>
                <tr><td style={{ borderBottom: '1px solid #333', padding: '4px 8px', color: '#e5e5e5' }}>T3 → blocks T1 (min)</td><td style={{ borderBottom: '1px solid #333', padding: '4px 8px' }}><input type="number" min="1" value={b5Config.t3_blocks_t1_min} onChange={(e) => setB5Config((p) => ({ ...p, t3_blocks_t1_min: e.target.value }))} style={{ width: 72, padding: '4px 6px' }} /></td></tr>
                <tr><td style={{ borderBottom: '1px solid #333', padding: '4px 8px', color: '#e5e5e5' }}>Position size ($)</td><td style={{ borderBottom: '1px solid #333', padding: '4px 8px' }}><input type="number" step="any" min="1" value={b5Config.position_size} onChange={(e) => setB5Config((p) => ({ ...p, position_size: e.target.value }))} style={{ width: 72, padding: '4px 6px' }} /></td></tr>
                <tr><td style={{ borderBottom: '1px solid #333', padding: '4px 8px', color: '#e5e5e5' }}>Early guard spread (%)</td><td style={{ borderBottom: '1px solid #333', padding: '4px 8px' }}><input type="number" step="any" min="0" value={b5Config.early_guard_spread_pct} onChange={(e) => setB5Config((p) => ({ ...p, early_guard_spread_pct: e.target.value }))} style={{ width: 72, padding: '4px 6px' }} /></td></tr>
                <tr><td style={{ borderBottom: '1px solid #333', padding: '4px 8px', color: '#e5e5e5' }}>Early guard cooldown (min)</td><td style={{ borderBottom: '1px solid #333', padding: '4px 8px' }}><input type="number" min="1" value={b5Config.early_guard_cooldown_min} onChange={(e) => setB5Config((p) => ({ ...p, early_guard_cooldown_min: e.target.value }))} style={{ width: 72, padding: '4px 6px' }} /></td></tr>
              </tbody>
            </table>
            <button type="submit" disabled={saving} style={saving ? buttonDisabledStyle : buttonStyle}>Save B5 config</button>
          </form>
        </div>
        <p style={{ marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: '#666' }}>B5 trades (last 200 filled).</span>
          <button type="button" onClick={downloadB5Csv} disabled={b5CsvLoading} style={{ ...buttonStyle, marginLeft: 12 }}>{b5CsvLoading ? 'Preparing…' : 'Download B5 CSV'}</button>
        </p>
        {b5Positions.length === 0 ? (
          <p style={{ color: '#666' }}>No B5 trades yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Time</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Tier</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Asset</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Venue</th>
                <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>Spread %</th>
                <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>Size</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Result</th>
              </tr>
            </thead>
            <tbody>
              {b5Positions.map((p) => {
                const raw = (p.raw ?? {}) as Record<string, unknown>;
                const tier = String(raw.tier ?? 'B5');
                const result = p.outcome === 'win' ? 'Win' : p.outcome === 'loss' ? 'Loss' : 'Pending';
                const resultColor = p.outcome === 'win' ? '#22c55e' : p.outcome === 'loss' ? '#ef4444' : '#888';
                return (
                  <tr key={p.id}>
                    <td style={{ borderBottom: '1px solid #eee', whiteSpace: 'nowrap' }}>{formatMst(p.entered_at, true)}</td>
                    <td style={{ borderBottom: '1px solid #eee' }}>{tier}</td>
                    <td style={{ borderBottom: '1px solid #eee' }}>{p.asset}</td>
                    <td style={{ borderBottom: '1px solid #eee' }}>{p.venue}</td>
                    <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>{p.strike_spread_pct?.toFixed(3)}</td>
                    <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>{p.position_size}</td>
                    <td style={{ borderBottom: '1px solid #eee', color: resultColor, fontWeight: result !== 'Pending' ? 600 : undefined }}>{result}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <p style={{ marginTop: 24, marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: '#666' }}>B5 placed (pending or not filled, last 100).</span>
        </p>
        {b5Unfilled.length === 0 ? (
          <p style={{ color: '#666' }}>No B5 pending or no-fill orders in the last 100.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Time</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Tier</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Asset</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Venue</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Price src</th>
                <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>Spread %</th>
                <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>Size</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Slug</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {b5Unfilled.map((p) => {
                const raw = (p.raw ?? {}) as Record<string, unknown>;
                const tier = String(raw.tier ?? 'B5');
                const status = p.outcome === 'no_fill' ? 'No fill' : 'Pending';
                const statusColor = p.outcome === 'no_fill' ? '#f59e0b' : '#888';
                return (
                  <tr key={p.id}>
                    <td style={{ borderBottom: '1px solid #eee', whiteSpace: 'nowrap' }}>{formatMst(p.entered_at, true)}</td>
                    <td style={{ borderBottom: '1px solid #eee' }}>{tier}</td>
                    <td style={{ borderBottom: '1px solid #eee' }}>{p.asset}</td>
                    <td style={{ borderBottom: '1px solid #eee' }}>{p.venue}</td>
                    <td style={{ borderBottom: '1px solid #eee' }}>{String(raw.price_source ?? '—')}</td>
                    <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>{p.strike_spread_pct != null ? p.strike_spread_pct.toFixed(3) : '—'}</td>
                    <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>{p.position_size}</td>
                    <td style={{ borderBottom: '1px solid #eee', fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.ticker_or_slug ?? ''}>{p.ticker_or_slug ?? '—'}</td>
                    <td style={{ borderBottom: '1px solid #eee', color: statusColor, fontWeight: 500 }}>{status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
