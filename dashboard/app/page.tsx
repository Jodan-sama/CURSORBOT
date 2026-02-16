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
  const [b4State, setB4State] = useState<{ bankroll: number; max_bankroll: number; daily_start_bankroll: number; daily_start_date: string; half_kelly_trades_left: number; consecutive_losses: number; results_json: boolean[]; updated_at: string } | null>(null);
  const [errors, setErrors] = useState<ErrorLog[]>([]);
  const [polySkips, setPolySkips] = useState<PolySkipRow[]>([]);
  const [claimStatus, setClaimStatus] = useState<{ message: string; created_at: string } | null>(null);
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
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    setLoadError(null);
    try {
      const spreadPromise = getSupabase().from('spread_thresholds').select('bot, asset, threshold_pct');
      const b4StatePromise = getSupabase().from('b4_state').select('*').eq('id', 'default').maybeSingle();
      const [
        { data: configData },
        { data: posData },
        { data: b4PosData },
        { data: errData },
        { data: polySkipData },
        spreadResult,
        { data: botSizesData },
        { data: claimLogData },
        b4StateResult,
      ] = await Promise.all([
        getSupabase().from('bot_config').select('*').eq('id', 'default').single(),
        getSupabase().from('positions').select('*').neq('bot', 'B4').order('entered_at', { ascending: false }).limit(200),
        getSupabase().from('positions').select('*').eq('bot', 'B4').order('entered_at', { ascending: false }).limit(50),
        getSupabase().from('error_log').select('*').order('created_at', { ascending: false }).limit(10),
        getSupabase().from('poly_skip_log').select('*').order('created_at', { ascending: false }).limit(50),
        Promise.resolve(spreadPromise).catch(() => ({ data: [] })),
        getSupabase().from('bot_position_sizes').select('bot, asset, size_kalshi, size_polymarket'),
        getSupabase().from('polymarket_claim_log').select('message, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
        Promise.resolve(b4StatePromise).catch(() => ({ data: null })),
      ]);
      setConfig(configData ?? null);
      setPositions((posData ?? []) as Position[]);
      setB4Positions((b4PosData ?? []) as Position[]);
      const b4Row = (b4StateResult as { data: unknown }).data as typeof b4State;
      setB4State(b4Row ?? null);
      setErrors((errData ?? []) as ErrorLog[]);
      setPolySkips((polySkipData ?? []) as PolySkipRow[]);
      const claimRow = claimLogData as { message: string; created_at: string } | null;
      setClaimStatus(claimRow ? { message: claimRow.message, created_at: claimRow.created_at } : null);
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

  async function setEmergencyOff(off: boolean) {
    setSaving(true);
    await getSupabase().from('bot_config').update({ emergency_off: off }).eq('id', 'default');
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

  function downloadCsv() {
    setCsvLoading(true);
    const headers = ['entered_at', 'bot', 'asset', 'exchange', 'price_source', 'strike_spread_pct', 'position_size', 'ticker_or_slug', 'order_id'];
    const rows = positions.map((p) =>
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
      ].join(',')
    );
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cursorbot-positions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setCsvLoading(false);
  }

  function downloadB4Csv() {
    setB4CsvLoading(true);
    const headers = ['time', 'bet', 'bankroll', 'phase', 'pnl'];
    const rows = b4Positions.map((p, idx) => {
      const raw = (p.raw ?? {}) as Record<string, unknown>;
      const bankroll = Number(raw.bankroll ?? 0);
      const nextRow = b4Positions[idx - 1];
      const nextRaw = nextRow ? ((nextRow.raw ?? {}) as Record<string, unknown>) : null;
      const nextBankroll = nextRaw ? Number(nextRaw.bankroll ?? 0) : null;
      const pnl = nextBankroll != null && bankroll > 0 ? nextBankroll - bankroll : '';
      return [
        escapeCsv(p.entered_at),
        escapeCsv(String(p.position_size)),
        escapeCsv(bankroll.toFixed(2)),
        escapeCsv(String(raw.phase ?? '')),
        escapeCsv(pnl !== '' ? pnl.toFixed(2) : ''),
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
        <h2 style={headingStyle}>Emergency</h2>
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
              {errors.map((e) => (
                <tr key={e.id}>
                  <td style={{ borderBottom: '1px solid #eee', whiteSpace: 'nowrap' }}>{formatMst(e.created_at, true)}</td>
                  <td style={{ borderBottom: '1px solid #eee', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.message}>{e.message}</td>
                  <td style={{ borderBottom: '1px solid #eee', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.context ? JSON.stringify(e.context) : undefined}>{e.context ? JSON.stringify(e.context) : '—'}</td>
                </tr>
              ))}
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
        <h2 style={headingStyle}>B4 — 5-Minute BTC Bot</h2>

        {b4State && (() => {
          const bankroll = Number(b4State.bankroll) || 0;
          const maxBankroll = Number(b4State.max_bankroll) || 0;
          const dailyStart = Number(b4State.daily_start_bankroll) || bankroll;
          const dailyPnl = bankroll - dailyStart;
          const dd = maxBankroll > 0 ? ((maxBankroll - bankroll) / maxBankroll * 100) : 0;
          const results = Array.isArray(b4State.results_json) ? b4State.results_json : [];
          const wr = results.length >= 10 ? (results.slice(-50).filter(Boolean).length / Math.min(50, results.length) * 100) : 0;
          const phase = bankroll < 200 ? '1' : bankroll < 5000 ? '2' : bankroll < 30000 ? '3' : bankroll < 200000 ? '4a' : '4b';
          const target = 1_000_000;
          const progressPct = Math.min(100, Math.max(0, (Math.log(bankroll) - Math.log(30)) / (Math.log(target) - Math.log(30)) * 100));
          return (
            <div style={{ marginBottom: 16, padding: 12, border: '1px solid #444', borderRadius: 8, background: '#111' }}>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 10 }}>
                <div>
                  <span style={{ fontSize: 12, color: '#aaa' }}>Bankroll</span>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#0D9488' }}>${bankroll.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                </div>
                <div>
                  <span style={{ fontSize: 12, color: '#aaa' }}>Phase</span>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#e5e5e5' }}>{phase}</div>
                </div>
                <div>
                  <span style={{ fontSize: 12, color: '#aaa' }}>Today P&L</span>
                  <div style={{ fontSize: 22, fontWeight: 700, color: dailyPnl >= 0 ? '#22c55e' : '#ef4444' }}>{dailyPnl >= 0 ? '+' : ''}{dailyPnl.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</div>
                </div>
                <div>
                  <span style={{ fontSize: 12, color: '#aaa' }}>Win Rate</span>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#e5e5e5' }}>{results.length >= 10 ? `${wr.toFixed(1)}%` : `${results.length} trades`}</div>
                </div>
                <div>
                  <span style={{ fontSize: 12, color: '#aaa' }}>Drawdown</span>
                  <div style={{ fontSize: 22, fontWeight: 700, color: dd > 10 ? '#ef4444' : '#e5e5e5' }}>{dd.toFixed(1)}%</div>
                </div>
                <div>
                  <span style={{ fontSize: 12, color: '#aaa' }}>Trades</span>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#e5e5e5' }}>{results.length}</div>
                </div>
              </div>
              <div style={{ fontSize: 12, color: '#bbb', marginBottom: 4 }}>Progress to $1,000,000 (log scale)</div>
              <div style={{ background: '#222', borderRadius: 4, height: 20, overflow: 'hidden', position: 'relative' }}>
                <div style={{ background: 'linear-gradient(90deg, #0D9488, #22c55e)', height: '100%', width: `${progressPct}%`, borderRadius: 4, transition: 'width 0.5s' }} />
                <span style={{ position: 'absolute', right: 6, top: 2, fontSize: 11, color: '#e5e5e5' }}>{progressPct.toFixed(1)}%</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#999', marginTop: 2 }}>
                <span>$30</span>
                <span>$200</span>
                <span>$5K</span>
                <span>$30K</span>
                <span>$200K</span>
                <span>$1M</span>
              </div>
              {b4State.updated_at && <div style={{ fontSize: 11, color: '#999', marginTop: 6 }}>Last updated: {formatMst(b4State.updated_at, true)}</div>}
            </div>
          );
        })()}

        <p style={{ marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: '#666' }}>Last 50 trades.</span>
          <button type="button" onClick={downloadB4Csv} disabled={b4CsvLoading} style={{ ...buttonStyle, marginLeft: 12 }}>{b4CsvLoading ? 'Preparing…' : 'Download B4 CSV'}</button>
        </p>
        {b4Positions.length === 0 ? (
          <p style={{ color: '#666' }}>No B4 trades yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Time</th>
                <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>Bet</th>
                <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>Bankroll</th>
                <th style={{ textAlign: 'center', borderBottom: '1px solid #ccc' }}>Phase</th>
                <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>P&L</th>
              </tr>
            </thead>
            <tbody>
              {b4Positions.map((p, idx) => {
                const raw = (p.raw ?? {}) as Record<string, unknown>;
                const bankroll = Number(raw.bankroll ?? 0);
                const bet = p.position_size;
                const nextRow = b4Positions[idx - 1];
                const nextRaw = nextRow ? ((nextRow.raw ?? {}) as Record<string, unknown>) : null;
                const nextBankroll = nextRaw ? Number(nextRaw.bankroll ?? 0) : null;
                const pnl = nextBankroll != null && bankroll > 0 ? nextBankroll - bankroll : null;
                return (
                  <tr key={p.id}>
                    <td style={{ borderBottom: '1px solid #eee', whiteSpace: 'nowrap' }}>{formatMst(p.entered_at, true)}</td>
                    <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>${bet}</td>
                    <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>${bankroll.toFixed(2)}</td>
                    <td style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>{String(raw.phase ?? '')}</td>
                    <td style={{ textAlign: 'right', borderBottom: '1px solid #eee', fontWeight: 600, color: pnl != null ? (pnl >= 0 ? '#16a34a' : '#dc2626') : '#888' }}>{pnl != null ? (pnl >= 0 ? `+$${pnl.toFixed(0)}` : `-$${Math.abs(pnl).toFixed(0)}`) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2 style={headingStyle}>B1/B2/B3 positions (last 200)</h2>
        <p style={{ marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: '#666' }}>Orders <strong>placed</strong> by the bot — limit orders may not fill; check the exchange for fill status.</span>
          <button type="button" onClick={downloadCsv} disabled={csvLoading} style={{ ...buttonStyle, marginLeft: 12 }}>{csvLoading ? 'Preparing…' : 'Download CSV (last 200)'}</button>
          <span style={{ display: 'block', fontSize: 13, color: '#555', marginTop: 6 }}>
            CSV includes <strong>exchange</strong> (kalshi/polymarket) and <strong>price_source</strong> (binance/coingecko).
          </span>
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
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.id}>
                <td style={{ borderBottom: '1px solid #eee' }}>{formatMst(p.entered_at, true)}</td>
                <td style={{ borderBottom: '1px solid #eee' }}>{p.bot}</td>
                <td style={{ borderBottom: '1px solid #eee' }}>{p.asset}</td>
                <td style={{ borderBottom: '1px solid #eee' }}>{p.venue}</td>
                <td style={{ borderBottom: '1px solid #eee' }}>{(p.raw as { price_source?: string })?.price_source ?? '—'}</td>
                <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>{p.strike_spread_pct?.toFixed(3)}</td>
                <td style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>{p.position_size}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={headingStyle}>Polymarket claim</h2>
        <p style={{ fontSize: 14, color: claimStatus?.message === 'NEED MORE POL' ? '#b91c1c' : '#666' }}>
          {claimStatus ? (
            claimStatus.message === 'NEED MORE POL' ? (
              <strong>NEED MORE POL</strong>
            ) : (
              <>
                {claimStatus.message}
                <span style={{ marginLeft: 8, fontSize: 12 }}>({formatMst(claimStatus.created_at, true)})</span>
              </>
            )
          ) : (
            'No claim runs yet.'
          )}
        </p>
      </section>
    </div>
  );
}
