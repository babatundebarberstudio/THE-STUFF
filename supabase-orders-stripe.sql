create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  customer_name text not null,
  customer_email text not null,
  customer_phone text not null,
  chicago_time text not null default '',
  is_pickup boolean,
  shipping_address text not null,
  notes text,
  subtotal numeric(10,2) not null,
  tax numeric(10,2) not null,
  shipping_cost numeric(10,2) not null,
  total numeric(10,2) not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'shipped', 'cancelled')),
  owner_notification_email text not null,
  stripe_session_id text,
  paid_at timestamptz,
  products_ordered text not null default '',
  created_at timestamptz not null default now()
);

alter table public.orders
  add column if not exists is_pickup boolean,
  add column if not exists stripe_session_id text,
  add column if not exists paid_at timestamptz,
  add column if not exists chicago_time text not null default '',
  add column if not exists products_ordered text not null default '';

alter table public.orders enable row level security;

drop policy if exists "public insert orders" on public.orders;
create policy "public insert orders"
on public.orders
for insert
to anon
with check (true);

drop policy if exists "owner read orders" on public.orders;
create policy "owner read orders"
on public.orders
for select
to anon
using (false);
