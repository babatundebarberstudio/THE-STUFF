create table if not exists public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  message text not null,
  created_at timestamptz not null default now()
);

alter table public.contact_messages enable row level security;

drop policy if exists "no public access to contact messages" on public.contact_messages;
create policy "no public access to contact messages"
on public.contact_messages
for all
to anon
using (false)
with check (false);
