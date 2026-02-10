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

export default function Dashboard() {
  const [config, setConfig] = useState<Config | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [errors, setErrors] = useState<ErrorLog[]>([]);
  const [spreadRows, setSpreadRows] = useState<SpreadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [kalshiSize, setKalshiSize] = useState('');
  const [polySize, setPolySize] = useState('');
  const [spreadEdits, setSpreadEdits] = useState<Record<string, string>>({});
  const [csvLoading, setCsvLoading] = useState(false);

  async function load() {
    const spreadPromise = getSupabase().from('spread_thresholds').select('bot, asset, threshold_pct');
    const [
      { data: configData },
      { data: posData },
      { data: errData },
      spreadResult,
    ] = await Promise.all([
      getSupabase().from('bot_config').select('*').eq('id', 'default').single(),
      getSupabase().from('positions').select('*').order('entered_at', { ascending: false }).limit(200),
      getSupabase().from('error_log').select('*').order('created_at', { ascending: false }).limit(50),
      Promise.resolve(spreadPromise).catch(() => ({ data: [] })),
    ]);
    setConfig(configData ?? null);
    setPositions((posData ?? []) as Position[]);
    setErrors((errData ?? []) as ErrorLog[]);
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
    if (configData) {
      setKalshiSize(String(configData.position_size_kalshi));
      setPolySize(String(configData.position_size_polymarket));
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
    await getSupabase()
      .from('bot_config')
      .update({
        position_size_kalshi: parseFloat(kalshiSize) || 0,
        position_size_polymarket: parseFloat(polySize) || 0,
      })
      .eq('id', 'default');
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
    const headers = ['entered_at', 'bot', 'asset', 'venue', 'strike_spread_pct', 'position_size', 'ticker_or_slug', 'order_id'];
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

  return (
    <div>
      <h1>Cursorbot Control</h1>

      <section style={{ marginBottom: 24 }}>
        <h2>Emergency</h2>
        <p>
          Status: <strong>{config?.emergency_off ? 'OFF (no new orders)' : 'Running'}</strong>
        </p>
        <button
          type="button"
          onClick={() => setEmergencyOff(true)}
          disabled={saving || config?.emergency_off}
          style={{ marginRight: 8, padding: '8px 16px' }}
        >
          Emergency OFF
        </button>
        <button
          type="button"
          onClick={() => setEmergencyOff(false)}
          disabled={saving || !config?.emergency_off}
          style={{ padding: '8px 16px' }}
        >
          Resume
        </button>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2>Position sizes</h2>
        <form onSubmit={saveSizes}>
          <label style={{ display: 'block', marginBottom: 8 }}>
            Kalshi size: <input type="number" step="any" value={kalshiSize} onChange={(e) => setKalshiSize(e.target.value)} style={{ marginLeft: 8 }} />
          </label>
          <label style={{ display: 'block', marginBottom: 8 }}>
            Polymarket size: <input type="number" step="any" value={polySize} onChange={(e) => setPolySize(e.target.value)} style={{ marginLeft: 8 }} />
          </label>
          <button type="submit" disabled={saving} style={{ padding: '8px 16px' }}>Save</button>
        </form>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2>Spread thresholds (%)</h2>
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
          <button type="submit" disabled={saving} style={{ padding: '8px 16px' }}>Save spread thresholds</button>
        </form>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2>Recent errors</h2>
        {errors.length === 0 ? (
          <p style={{ color: '#666' }}>No errors logged.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Time</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Message</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Context</th>
              </tr>
            </thead>
            <tbody>
              {errors.map((e) => (
                <tr key={e.id}>
                  <td style={{ borderBottom: '1px solid #eee', whiteSpace: 'nowrap' }}>{new Date(e.created_at).toISOString()}</td>
                  <td style={{ borderBottom: '1px solid #eee', maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.message}</td>
                  <td style={{ borderBottom: '1px solid #eee' }}>{e.context ? JSON.stringify(e.context) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Recent positions (last 200)</h2>
        <p style={{ marginBottom: 8 }}>
          <button type="button" onClick={downloadCsv} disabled={csvLoading} style={{ padding: '8px 16px' }}>
            {csvLoading ? 'Preparing…' : 'Download CSV (last 200 trades)'}
          </button>
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
                <td style={{ borderBottom: '1px solid #eee' }}>{new Date(p.entered_at).toISOString()}</td>
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
    </div>
  );
}
