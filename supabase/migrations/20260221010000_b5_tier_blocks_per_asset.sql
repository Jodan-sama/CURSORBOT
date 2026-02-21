-- B5 tier blocks: per-asset (ETH, SOL, XRP) so one asset's T2/T3 doesn't block others.

-- Remove legacy single row so id can be asset name
delete from b5_tier_blocks where id = 'default';

-- One row per asset
insert into b5_tier_blocks (id, t1_blocked_until_ms, t2_blocked_until_ms, updated_at)
values
  ('ETH', 0, 0, now()),
  ('SOL', 0, 0, now()),
  ('XRP', 0, 0, now())
on conflict (id) do nothing;
