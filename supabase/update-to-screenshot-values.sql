-- Update bot_config and spread_thresholds to match your screenshot values.
-- Run this in Supabase SQL Editor after the main schema.

-- Delays & B2 spread threshold
UPDATE bot_config SET
  b3_block_min = 60,
  b2_high_spread_threshold_pct = 0.55,
  b2_high_spread_block_min = 15,
  b3_early_high_spread_pct = 1.8,
  b3_early_high_spread_block_min = 15
WHERE id = 'default';

-- Spread thresholds (%)
INSERT INTO spread_thresholds (bot, asset, threshold_pct) VALUES
  ('B1', 'BTC', 0.26), ('B1', 'ETH', 0.295), ('B1', 'SOL', 0.31), ('B1', 'XRP', 0.31),
  ('B2', 'BTC', 0.58), ('B2', 'ETH', 0.59), ('B2', 'SOL', 0.65), ('B2', 'XRP', 0.65),
  ('B3', 'BTC', 1), ('B3', 'ETH', 1), ('B3', 'SOL', 1), ('B3', 'XRP', 1)
ON CONFLICT (bot, asset) DO UPDATE SET threshold_pct = EXCLUDED.threshold_pct;
