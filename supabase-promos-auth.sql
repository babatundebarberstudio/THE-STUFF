-- Run in Supabase SQL editor. Enables promo tracking + optional order columns.
-- Also enable Email provider under Authentication > Providers if not already.

create table if not exists public.promo_codes (
  code text primary key,
  percent_off numeric(5,2) not null check (percent_off > 0 and percent_off <= 100),
  max_total_redemptions int,
  per_user_limit int not null default 1 check (per_user_limit > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.promo_redemptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  promo_code text not null references public.promo_codes (code) on delete restrict,
  order_id uuid references public.orders (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (user_id, promo_code)
);

alter table public.promo_codes enable row level security;
alter table public.promo_redemptions enable row level security;

-- No public policies: only service role (your server) reads/writes these tables.

insert into public.promo_codes (code, percent_off, max_total_redemptions, per_user_limit, active)
values ('LAUNCHDAY', 30, null, 1, true)
on conflict (code) do update set
  percent_off = excluded.percent_off,
  per_user_limit = excluded.per_user_limit,
  active = excluded.active;

alter table public.orders add column if not exists promo_code text;
alter table public.orders add column if not exists discount_percent numeric(5,2);
alter table public.orders add column if not exists shopper_user_id uuid references auth.users (id);
