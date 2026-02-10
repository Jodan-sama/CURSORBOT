# Supabase setup

## Run the schema

1. Open your Supabase project: **SQL Editor**.
2. Copy the **entire** contents of `supabase/schema.sql` from this repo.
3. Paste into a new query and click **Run**.

That creates (or skips if already present) all tables and seeds default config and spread thresholds. You only need to do this once, or when we add new tables.

## What is RLS?

**RLS = Row Level Security.** It’s a Postgres feature that limits which rows a user can read or change. When RLS is **on** for a table, you must add **policies** (e.g. “anon can SELECT”) or no rows are visible.

- If your project is **private** (only you use the dashboard), many people leave RLS **off** for these tables so the anon key can read/write what the app needs.
- If RLS is **on**, add policies so the anon key can:
  - **bot_config**: SELECT, UPDATE (for `id = 'default'`)
  - **positions**: SELECT
  - **error_log**: SELECT
  - **spread_thresholds**: SELECT, INSERT, UPDATE (for upsert)

You can set policies under **Table Editor** → select table → **Policies**, or in SQL with `CREATE POLICY`.
