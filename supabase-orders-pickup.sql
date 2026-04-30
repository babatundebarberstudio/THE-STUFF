-- Adds pickup flag for new/future orders without rewriting older rows.
alter table public.orders
  add column if not exists is_pickup boolean;
