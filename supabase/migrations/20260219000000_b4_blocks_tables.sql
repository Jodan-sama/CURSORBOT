-- B4 spread-runner only: tier blocks (T2→T1, T3→T1+T2) and early-guard cooldown.
-- Single row per table (id='default'). Read on startup; write when setting a block. Do not use for B1/B2/B3.

create table if not exists b4_tier_blocks (
  id text primary key default 'default',
  t1_blocked_until_ms bigint not null default 0,
  t2_blocked_until_ms bigint not null default 0,
  updated_at timestamptz not null default now()
);

insert into b4_tier_blocks (id) values ('default') on conflict (id) do nothing;

create table if not exists b4_early_guard (
  id text primary key default 'default',
  cooldown_until_ms bigint not null default 0,
  updated_at timestamptz not null default now()
);

insert into b4_early_guard (id) values ('default') on conflict (id) do nothing;
