-- Separate pause for B123c: B4 uses cooldown_until_ms, B123c uses b123c_cooldown_until_ms (1 = paused, 0 = running).
alter table b4_state add column if not exists b123c_cooldown_until_ms bigint not null default 0;
