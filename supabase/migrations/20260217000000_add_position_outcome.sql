-- Resolution outcome for Polymarket B4 / B1c/B2c/B3c. Set once by resolve-polymarket-outcomes script.
-- Run in Supabase Dashboard → SQL Editor (once) so the resolver and dashboard can use outcome/resolved_at.
alter table positions add column if not exists outcome text check (outcome is null or outcome in ('win', 'loss'));
alter table positions add column if not exists resolved_at timestamptz;
