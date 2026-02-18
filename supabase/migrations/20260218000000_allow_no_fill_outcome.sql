-- Allow outcome = 'no_fill' for unfilled limit orders (no size_matched). Resolver sets this; dashboard hides these.
alter table positions drop constraint if exists positions_outcome_check;
alter table positions add constraint positions_outcome_check check (
  outcome is null or outcome in ('win', 'loss', 'no_fill')
);
