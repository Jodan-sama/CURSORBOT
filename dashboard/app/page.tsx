'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

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
};

export default function Dashboard() {
  const [config, setConfig] = useState<Config | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [kalshiSize, setKalshiSize] = useState('');
  const [polySize, setPolySize] = useState('');

  async function load() {
    const [{ data: configData }, { data: posData }] = await Promise.all([
      supabase.from('bot_config').select('*').eq('id', 'default').single(),
      supabase.from('positions').select('*').order('entered_at', { ascending: false }).limit(50),
    ]);
    setConfig(configData ?? null);
    setPositions((posData ?? []) as Position[]);
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
    await supabase.from('bot_config').update({ emergency_off: off }).eq('id', 'default');
    await load();
    setSaving(false);
  }

  async function saveSizes(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await supabase
      .from('bot_config')
      .update({
        position_size_kalshi: parseFloat(kalshiSize) || 0,
        position_size_polymarket: parseFloat(polySize) || 0,
      })
      .eq('id', 'default');
    await load();
    setSaving(false);
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

      <section>
        <h2>Recent positions</h2>
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
