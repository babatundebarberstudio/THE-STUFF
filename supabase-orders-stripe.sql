create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  customer_name text not null,
  customer_email text not null,
  customer_phone text not null,
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
  created_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_slug text not null,
  product_name text not null,
  unit_price numeric(10,2) not null,
  quantity int not null check (quantity > 0),
  line_total numeric(10,2) not null,
  created_at timestamptz not null default now()
);

alter table public.orders
  add column if not exists stripe_session_id text,
  add column if not exists paid_at timestamptz;

alter table public.orders enable row level security;
alter table public.order_items enable row level security;

drop policy if exists "public insert orders" on public.orders;
create policy "public insert orders"
on public.orders
for insert
to anon
with check (true);

drop policy if exists "public insert order items" on public.order_items;
create policy "public insert order items"
on public.order_items
for insert
to anon
with check (true);

drop policy if exists "owner read orders" on public.orders;
create policy "owner read orders"
on public.orders
for select
to anon
using (false);

drop policy if exists "owner read order items" on public.order_items;
create policy "owner read order items"
on public.order_items
for select
to anon
using (false);
