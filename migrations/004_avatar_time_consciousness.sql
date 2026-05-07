create table if not exists public.wa_temporal_events (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  avatar_name text not null,
  memory_id int null,
  event_type text not null,
  trigger_at timestamptz not null,
  action jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index if not exists idx_wa_temporal_events_status_trigger
  on public.wa_temporal_events (status, trigger_at);

create index if not exists idx_wa_temporal_events_user_avatar
  on public.wa_temporal_events (user_id, avatar_name, created_at desc);

alter table public.wa_temporal_events enable row level security;
drop policy if exists "temporal_events_select" on public.wa_temporal_events;
create policy "temporal_events_select" on public.wa_temporal_events for select using (true);
drop policy if exists "temporal_events_insert" on public.wa_temporal_events;
create policy "temporal_events_insert" on public.wa_temporal_events for insert with check (true);
drop policy if exists "temporal_events_update" on public.wa_temporal_events;
create policy "temporal_events_update" on public.wa_temporal_events for update using (true);

create table if not exists public.wa_temporal_preferences (
  user_id text not null,
  avatar_name text not null,
  timezone text not null default 'UTC',
  quiet_hours_start time null,
  quiet_hours_end time null,
  preferred_call_times jsonb not null default '[]'::jsonb,
  reminder_lead_minutes int not null default 30,
  morning_briefing boolean not null default true,
  proactive_calls boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, avatar_name)
);

alter table public.wa_temporal_preferences enable row level security;
drop policy if exists "temporal_preferences_select" on public.wa_temporal_preferences;
create policy "temporal_preferences_select" on public.wa_temporal_preferences for select using (true);
drop policy if exists "temporal_preferences_insert" on public.wa_temporal_preferences;
create policy "temporal_preferences_insert" on public.wa_temporal_preferences for insert with check (true);
drop policy if exists "temporal_preferences_update" on public.wa_temporal_preferences;
create policy "temporal_preferences_update" on public.wa_temporal_preferences for update using (true);

create table if not exists public.wa_temporal_patterns (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  pattern_type text not null,
  pattern_data jsonb not null default '{}'::jsonb,
  detected_at timestamptz not null default now(),
  session_count int not null default 0,
  active boolean not null default true
);

create index if not exists idx_wa_temporal_patterns_user_type
  on public.wa_temporal_patterns (user_id, pattern_type, detected_at desc);

alter table public.wa_temporal_patterns enable row level security;
drop policy if exists "temporal_patterns_select" on public.wa_temporal_patterns;
create policy "temporal_patterns_select" on public.wa_temporal_patterns for select using (true);
drop policy if exists "temporal_patterns_insert" on public.wa_temporal_patterns;
create policy "temporal_patterns_insert" on public.wa_temporal_patterns for insert with check (true);
drop policy if exists "temporal_patterns_update" on public.wa_temporal_patterns;
create policy "temporal_patterns_update" on public.wa_temporal_patterns for update using (true);

create or replace function public.set_wa_temporal_preferences_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_wa_temporal_preferences_updated_at on public.wa_temporal_preferences;
create trigger trg_wa_temporal_preferences_updated_at
before update on public.wa_temporal_preferences
for each row
execute function public.set_wa_temporal_preferences_updated_at();
