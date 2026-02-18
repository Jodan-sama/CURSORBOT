/**
 * B5-only Supabase: b5_config (min edge) and b5_losses. Does not use src/db/supabase.ts.
 * D3 B5 runner: SUPABASE_URL + SUPABASE_ANON_KEY in .env to read min_edge and log losses.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const B5_LOSSES_MAX = 20;

function getB5Supabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !key) return null;
  return createClient(url, key);
}

/** Get B5 min edge from Supabase (b5_config). Returns null if table missing or no row. */
export async function getB5MinEdgeFromSupabase(): Promise<number | null> {
  try {
    const supabase = getB5Supabase();
    if (!supabase) return null;
    const { data, error } = await supabase
      .from('b5_config')
      .select('min_edge')
      .eq('id', 'default')
      .maybeSingle();
    if (error || data == null) return null;
    const n = Number((data as { min_edge: number }).min_edge);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Log a B5 losing trade and trim to last 20 losses. Does not throw. */
export async function logB5Loss(entry: {
  edge_at_entry: number;
  question: string;
  slug?: string;
}): Promise<void> {
  try {
    const supabase = getB5Supabase();
    if (!supabase) return;
    const { data: inserted, error: insertErr } = await supabase
      .from('b5_losses')
      .insert({
        edge_at_entry: entry.edge_at_entry,
        question: entry.question,
        slug: entry.slug ?? null,
      })
      .select('id')
      .single();
    if (insertErr || !inserted) return;

    const { data: rows } = await supabase
      .from('b5_losses')
      .select('id')
      .order('created_at', { ascending: false });
    const all = (rows ?? []) as { id: string }[];
    if (all.length <= B5_LOSSES_MAX) return;
    const toDelete = all.slice(B5_LOSSES_MAX);
    for (const row of toDelete) {
      await supabase.from('b5_losses').delete().eq('id', row.id);
    }
  } catch (e) {
    console.warn('[B5] logB5Loss failed:', e instanceof Error ? e.message : e);
  }
}
