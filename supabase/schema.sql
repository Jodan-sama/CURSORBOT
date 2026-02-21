-- Cursorbot: config, positions log, and B3→B2/B1 block state

-- Single row: emergency off + position sizes + delay config
create table if not exists bot_config (
  id text primary key default 'default',
  emergency_off boolean not null default false,
  position_size_kalshi numeric not null default 1,
  position_size_polymarket numeric not null default 5,
  b3_block_min integer not null default 60,
  b2_high_spread_threshold_pct numeric not null default 0.55,
  b2_high_spread_block_min integer not null default 15,
  b3_early_high_spread_pct numeric not null default 1.8,
  b3_early_high_spread_block_min integer not null default 15,
  updated_at timestamptz not null default now()
);

-- Per-bot, per-asset position size overrides (optional). Key: "B1"|"B2"|"B3", asset: "BTC"|"ETH"|"SOL"|"XRP"
create table if not exists bot_position_sizes (
  bot text not null,
  asset text not null,
  size_kalshi numeric,
  size_polymarket numeric,
  primary key (bot, asset)
);

-- Log every position entered (both exchanges)
create table if not exists positions (
  id uuid primary key default gen_random_uuid(),
  entered_at timestamptz not null default now(),
  bot text not null,
  asset text not null,
  venue text not null check (venue in ('kalshi', 'polymarket')),
  strike_spread_pct numeric not null,
  position_size numeric not null,
  ticker_or_slug text,
  order_id text,
  raw jsonb
);

create index if not exists positions_entered_at on positions (entered_at desc);
create index if not exists positions_bot_asset on positions (bot, asset);

-- When B3 places an order, block B1/B2 for that asset. Block expires at block_until.
create table if not exists asset_blocks (
  asset text not null primary key,
  block_until timestamptz not null,
  created_at timestamptz not null default now()
);

-- Error log (for dashboard and debugging)
create table if not exists error_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  message text not null,
  context jsonb,
  stack text
);

create index if not exists error_log_created_at on error_log (created_at desc);

-- B4 paper trader log (last 20 shown on dashboard). asset = BTC | ETH | SOL.
create table if not exists b4_paper_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  window_unix bigint not null,
  asset text not null default 'BTC',
  event text not null,
  direction text,
  price numeric
);

create index if not exists b4_paper_log_created_at on b4_paper_log (created_at desc);

-- Polymarket claim status (ALL ITEMS CLAIMED | NEED MORE POL | CLAIM INCOMPLETE). One row per run.
-- Claim script inserts; dashboard reads. If RLS is on, allow anon: INSERT, SELECT.
create table if not exists polymarket_claim_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  message text not null
);

create index if not exists polymarket_claim_log_created_at on polymarket_claim_log (created_at desc);

-- Polymarket skip reasons (why Poly order was not placed). Dashboard shows last 50.
create table if not exists poly_skip_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  bot text not null,
  asset text not null,
  reason text not null,
  kalshi_placed boolean not null default false
);

create index if not exists poly_skip_log_created_at on poly_skip_log (created_at desc);

-- Spread thresholds (pct) per bot per asset. Bot enters when spread > threshold. Defaults seeded below.
create table if not exists spread_thresholds (
  bot text not null,
  asset text not null,
  threshold_pct numeric not null,
  primary key (bot, asset)
);

-- For existing deployments: add/update delay columns
alter table bot_config add column if not exists b3_block_min integer not null default 60;
alter table bot_config add column if not exists b2_high_spread_threshold_pct numeric not null default 0.55;
alter table bot_config add column if not exists b2_high_spread_block_min integer not null default 15;
alter table bot_config add column if not exists b3_early_high_spread_pct numeric not null default 1.8;
alter table bot_config add column if not exists b3_early_high_spread_block_min integer not null default 15;

-- Seed config
insert into bot_config (id, emergency_off) values ('default', false)
on conflict (id) do nothing;

-- B4 bot state persistence (bankroll, win/loss history, risk state). Single row, id='default'.
create table if not exists b4_state (
  id text primary key default 'default',
  bankroll numeric not null default 30,
  max_bankroll numeric not null default 30,
  consecutive_losses integer not null default 0,
  cooldown_until_ms bigint not null default 0,
  results_json jsonb not null default '[]',
  daily_start_bankroll numeric not null default 30,
  daily_start_date text not null default '',
  half_kelly_trades_left integer not null default 0,
  updated_at timestamptz not null default now()
);

insert into b4_state (id) values ('default') on conflict (id) do nothing;

-- B4 spread-runner only: tier blocks and early-guard cooldown (read on startup; write when setting block).
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

-- B5 spread-runner (D3): state, tier blocks, early guard (ETH/SOL/XRP 5m).
create table if not exists b5_state (
  id text primary key default 'default',
  bankroll numeric not null default 50,
  max_bankroll numeric not null default 50,
  consecutive_losses integer not null default 0,
  cooldown_until_ms bigint not null default 0,
  results_json jsonb not null default '{}',
  daily_start_bankroll numeric not null default 50,
  daily_start_date text not null default '',
  half_kelly_trades_left integer not null default 0,
  updated_at timestamptz not null default now()
);
insert into b5_state (id) values ('default') on conflict (id) do nothing;

create table if not exists b5_tier_blocks (
  id text primary key,
  t1_blocked_until_ms bigint not null default 0,
  t2_blocked_until_ms bigint not null default 0,
  updated_at timestamptz not null default now()
);
insert into b5_tier_blocks (id, t1_blocked_until_ms, t2_blocked_until_ms, updated_at) values ('ETH', 0, 0, now()), ('SOL', 0, 0, now()), ('XRP', 0, 0, now()) on conflict (id) do nothing;

create table if not exists b5_early_guard (
  id text primary key default 'default',
  cooldown_until_ms bigint not null default 0,
  updated_at timestamptz not null default now()
);
insert into b5_early_guard (id) values ('default') on conflict (id) do nothing;

-- Seed spread thresholds (B1/B2/B3 x BTC/ETH/SOL/XRP). For existing DBs: add XRP if missing.
insert into spread_thresholds (bot, asset, threshold_pct) values
  ('B1', 'BTC', 0.21), ('B1', 'ETH', 0.23), ('B1', 'SOL', 0.27), ('B1', 'XRP', 0.27),
  ('B2', 'BTC', 0.57), ('B2', 'ETH', 0.57), ('B2', 'SOL', 0.62), ('B2', 'XRP', 0.62),
  ('B3', 'BTC', 1.0),  ('B3', 'ETH', 1.0),  ('B3', 'SOL', 1.0),  ('B3', 'XRP', 1.0)
on conflict (bot, asset) do nothing;

-- Resolution outcome for Polymarket positions (B4, B1c/B2c/B3c). Set once by resolver job. no_fill = order never filled.
alter table positions add column if not exists outcome text check (outcome is null or outcome in ('win', 'loss', 'no_fill'));
alter table positions add column if not exists resolved_at timestamptz;
