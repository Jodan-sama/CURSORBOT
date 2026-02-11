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

-- Seed config
insert into bot_config (id, emergency_off) values ('default', false)
on conflict (id) do nothing;

-- Seed spread thresholds (B1/B2/B3 x BTC/ETH/SOL/XRP). For existing DBs: add XRP if missing.
insert into spread_thresholds (bot, asset, threshold_pct) values
  ('B1', 'BTC', 0.21), ('B1', 'ETH', 0.23), ('B1', 'SOL', 0.27), ('B1', 'XRP', 0.27),
  ('B2', 'BTC', 0.57), ('B2', 'ETH', 0.57), ('B2', 'SOL', 0.62), ('B2', 'XRP', 0.62),
  ('B3', 'BTC', 1.0),  ('B3', 'ETH', 1.0),  ('B3', 'SOL', 1.0),  ('B3', 'XRP', 1.0)
on conflict (bot, asset) do nothing;
