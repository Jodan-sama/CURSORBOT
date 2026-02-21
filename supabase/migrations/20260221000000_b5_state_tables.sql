-- B5 spread-runner (D3): state, tier blocks, early guard. Mirror of B4 for ETH/SOL/XRP 5m.

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

insert into b5_state (id, results_json) values ('default', '{
  "eth_t1_spread": 0.32, "eth_t2_spread": 0.181, "eth_t3_spread": 0.110,
  "sol_t1_spread": 0.32, "sol_t2_spread": 0.206, "sol_t3_spread": 0.121,
  "xrp_t1_spread": 0.32, "xrp_t2_spread": 0.206, "xrp_t3_spread": 0.121,
  "t2_block_min": 5, "t3_block_min": 15, "position_size": 5,
  "early_guard_spread_pct": 0.45, "early_guard_cooldown_min": 60
}'::jsonb) on conflict (id) do nothing;

create table if not exists b5_tier_blocks (
  id text primary key default 'default',
  t1_blocked_until_ms bigint not null default 0,
  t2_blocked_until_ms bigint not null default 0,
  updated_at timestamptz not null default now()
);

insert into b5_tier_blocks (id) values ('default') on conflict (id) do nothing;

create table if not exists b5_early_guard (
  id text primary key default 'default',
  cooldown_until_ms bigint not null default 0,
  updated_at timestamptz not null default now()
);

insert into b5_early_guard (id) values ('default') on conflict (id) do nothing;
