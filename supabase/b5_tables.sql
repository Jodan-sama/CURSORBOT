-- B5 only: min edge config + loss log. Does not affect D1/D2 or any other tables.
-- Run this once in Supabase SQL Editor (same project as dashboard).

-- Single row: B5 min edge (dashboard updates; D3 B5 runner reads).
create table if not exists b5_config (
  id text primary key default 'default',
  min_edge numeric not null default 0.2,
  updated_at timestamptz not null default now()
);

insert into b5_config (id, min_edge) values ('default', 0.2)
on conflict (id) do nothing;

-- Last 20 losing trades: edge at entry + question/slug (B5 runner inserts; dashboard reads).
create table if not exists b5_losses (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  edge_at_entry numeric not null,
  question text not null,
  slug text
);

create index if not exists b5_losses_created_at on b5_losses (created_at desc);

-- RLS: allow anon SELECT/INSERT/UPDATE on these tables only (if you use RLS, add policies for b5_config and b5_losses).
-- If your project does not use RLS, no change needed.
