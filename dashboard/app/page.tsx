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
const ASSETS = ['BTC', 'ETH', 'SOL'] as const;

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

/** Raw row from b4_paper_log (B4 46/50: profit / loss / no_fill per asset per cycle) */
type B4LogRow = {
  id: string;
  window_unix: number;
  asset: string | null;
  event: string;
  price: number | null;
};
/** One 15m cycle: window_unix → BTC, ETH, SOL result (dollars or null = no fill) */
type B4Cycle = {
  window_unix: number;
  btc: number | null;
  eth: number | null;
  sol: number | null;
};

export default function Dashboard() {
  const [config, setConfig] = useState<Config | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [errors, setErrors] = useState<ErrorLog[]>([]);
  const [polySkips, setPolySkips] = useState<PolySkipRow[]>([]);
  const [b4Cycles, setB4Cycles] = useState<B4Cycle[]>([]);
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
  const [csvLoading, setCsvLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    setLoadError(null);
    try {
      const spreadPromise = getSupabase().from('spread_thresholds').select('bot, asset, threshold_pct');
      const [
        { data: configData },
        { data: posData },
        { data: errData },
        { data: polySkipData },
        spreadResult,
        { data: botSizesData },
        { data: b4Data },
        { data: claimLogData },
      ] = await Promise.all([
        getSupabase().from('bot_config').select('*').eq('id', 'default').single(),
        getSupabase().from('positions').select('*').order('entered_at', { ascending: false }).limit(200),
        getSupabase().from('error_log').select('*').order('created_at', { ascending: false }).limit(10),
        getSupabase().from('poly_skip_log').select('*').order('created_at', { ascending: false }).limit(50),
        Promise.resolve(spreadPromise).catch(() => ({ data: [] })),
        getSupabase().from('bot_position_sizes').select('bot, asset, size_kalshi, size_polymarket'),
        getSupabase().from('b4_paper_log').select('window_unix, asset, event, price').in('event', ['profit', 'loss', 'no_fill']).order('window_unix', { ascending: false }).limit(120),
        getSupabase().from('polymarket_claim_log').select('message, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      ]);
      setConfig(configData ?? null);
      setPositions((posData ?? []) as Position[]);
      setErrors((errData ?? []) as ErrorLog[]);
      setPolySkips((polySkipData ?? []) as PolySkipRow[]);
      const b4Rows = (b4Data ?? []) as B4LogRow[];
      const cycleMap = new Map<number, { btc: number | null; eth: number | null; sol: number | null }>();
      for (const r of b4Rows) {
        const w = Number(r.window_unix);
        if (!cycleMap.has(w)) cycleMap.set(w, { btc: null, eth: null, sol: null });
        const row = cycleMap.get(w)!;
        const val = r.event === 'no_fill' ? null : (r.price ?? null);
        if (r.asset === 'BTC') row.btc = val;
        else if (r.asset === 'ETH') row.eth = val;
        else if (r.asset === 'SOL') row.sol = val;
      }
      const claimRow = claimLogData as { message: string; created_at: string } | null;
      setClaimStatus(claimRow ? { message: claimRow.message, created_at: claimRow.created_at } : null);
      const cycles: B4Cycle[] = Array.from(cycleMap.entries())
        .sort((a, b) => b[0] - a[0])
        .slice(0, 20)
        .map(([window_unix, { btc, eth, sol }]) => ({ window_unix, btc, eth, sol }));
      setB4Cycles(cycles);
      const rows = ((spreadResult as { data: SpreadRow[] }).data ?? []) as SpreadRow[];
      setSpreadRows(rows);
      const defaults: Record<string, string> = {
        'B1-BTC': '0.21', 'B1-ETH': '0.23', 'B1-SOL': '0.27',
        'B2-BTC': '0.57', 'B2-ETH': '0.57', 'B2-SOL': '0.62',
        'B3-BTC': '1', 'B3-ETH': '1', 'B3-SOL': '1',
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
    const headers = ['entered_at', 'bot', 'asset', 'exchange', 'strike_spread_pct', 'position_size', 'ticker_or_slug', 'order_id'];
    const rows = positions.map((p) =>
      [
        escapeCsv(p.entered_at),
        escapeCsv(p.bot),
        escapeCsv(p.asset),
        escapeCsv(p.venue),
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

      <section>
        <h2 style={headingStyle}>Recent positions (last 200)</h2>
        <p style={{ marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: '#666' }}>Orders <strong>placed</strong> by the bot — limit orders may not fill; check the exchange for fill status.</span>
          <button type="button" onClick={downloadCsv} disabled={csvLoading} style={{ ...buttonStyle, marginLeft: 12 }}>{csvLoading ? 'Preparing…' : 'Download CSV (last 200)'}</button>
          <span style={{ display: 'block', fontSize: 13, color: '#555', marginTop: 6 }}>
            CSV includes an <strong>exchange</strong> column: <code>kalshi</code> or <code>polymarket</code>.
          </span>
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Time</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Bot</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Asset</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Venue</th>
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

      <section style={{ marginTop: 24 }}>
        <h2 style={headingStyle}>B4 46/50 (last 20 cycles)</h2>
        <p style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>Per 15m cycle: buy 46¢, sell 50¢. Profit when sold at 50; loss when bought at 46 and never sold.</p>
        {b4Cycles.length === 0 ? (
          <p style={{ color: '#666' }}>No B4 cycles yet.</p>
        ) : (
          <table style={{ width: '100%', maxWidth: 560, borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Cycle (window end)</th>
                <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>BTC</th>
                <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>ETH</th>
                <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc' }}>SOL</th>
              </tr>
            </thead>
            <tbody>
              {b4Cycles.map((c) => (
                <tr key={c.window_unix}>
                  <td style={{ borderBottom: '1px solid #eee', whiteSpace: 'nowrap' }}>{formatMst(new Date(c.window_unix * 1000).toISOString(), true)}</td>
                  <td style={{ textAlign: 'right', borderBottom: '1px solid #eee', color: c.btc != null ? (c.btc >= 0 ? 'green' : 'red') : undefined }}>
                    {c.btc != null ? (c.btc >= 0 ? `+$${c.btc.toFixed(2)}` : `-$${Math.abs(c.btc).toFixed(2)}`) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', borderBottom: '1px solid #eee', color: c.eth != null ? (c.eth >= 0 ? 'green' : 'red') : undefined }}>
                    {c.eth != null ? (c.eth >= 0 ? `+$${c.eth.toFixed(2)}` : `-$${Math.abs(c.eth).toFixed(2)}`) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', borderBottom: '1px solid #eee', color: c.sol != null ? (c.sol >= 0 ? 'green' : 'red') : undefined }}>
                    {c.sol != null ? (c.sol >= 0 ? `+$${c.sol.toFixed(2)}` : `-$${Math.abs(c.sol).toFixed(2)}`) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
