create extension if not exists pgcrypto;

create table if not exists public.wa_tavus_sessions (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique,
  conversation_id uuid references public.wa_conversations(id) on delete set null,
  owner_id uuid references public.wa_owners(id) on delete set null,
  persona_name text,
  replica_id text,
  language text,
  status text not null default 'started',
  join_url text,
  backend_base_url text,
  started_at timestamptz,
  ended_at timestamptz,
  ended_reason text,
  last_event_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_wa_tavus_sessions_owner_started_at
  on public.wa_tavus_sessions (owner_id, started_at desc);

create index if not exists idx_wa_tavus_sessions_status_last_event_at
  on public.wa_tavus_sessions (status, last_event_at desc);

create or replace function public.set_wa_tavus_sessions_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_wa_tavus_sessions_updated_at on public.wa_tavus_sessions;

create trigger trg_wa_tavus_sessions_updated_at
before update on public.wa_tavus_sessions
for each row
execute function public.set_wa_tavus_sessions_updated_at();
