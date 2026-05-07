create table if not exists public.wa_channel_state (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.wa_conversations(id) on delete cascade unique,
  timezone text not null default 'UTC',
  last_channel text not null default 'chat',
  last_language text not null default 'en',
  last_call_status text not null default 'idle',
  last_session_id text null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_wa_channel_state_updated_at
  on public.wa_channel_state (updated_at desc);

alter table public.wa_channel_state enable row level security;

drop policy if exists "channel_state_select" on public.wa_channel_state;
create policy "channel_state_select" on public.wa_channel_state
  for select using (true);

drop policy if exists "channel_state_insert" on public.wa_channel_state;
create policy "channel_state_insert" on public.wa_channel_state
  for insert with check (true);

drop policy if exists "channel_state_update" on public.wa_channel_state;
create policy "channel_state_update" on public.wa_channel_state
  for update using (true);

create or replace function public.set_wa_channel_state_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_wa_channel_state_updated_at on public.wa_channel_state;
create trigger trg_wa_channel_state_updated_at
before update on public.wa_channel_state
for each row
execute function public.set_wa_channel_state_updated_at();
