-- Health check history for the /status page
create table if not exists public.wa_health_checks (
  id uuid default gen_random_uuid() primary key,
  timestamp timestamptz not null default now(),
  check_name text not null,           -- db_schema, opm, auth, tts
  status text not null,               -- ok, fail
  message text,
  response_time_ms integer
);

create index idx_health_checks_name_ts on public.wa_health_checks (check_name, timestamp desc);

-- Keep only 8 days of data (cron can run a cleanup)
-- Incidents log
create table if not exists public.wa_incidents (
  id uuid default gen_random_uuid() primary key,
  check_name text not null,
  started_at timestamptz not null default now(),
  resolved_at timestamptz,
  message text
);

create index idx_incidents_check_name on public.wa_incidents (check_name, started_at desc);

-- Allow service role full access (no RLS needed — only server-side access)
alter table public.wa_health_checks enable row level security;
alter table public.wa_incidents enable row level security;

-- Public read for the status page (anon key)
create policy "Public read health checks" on public.wa_health_checks for select using (true);
create policy "Public read incidents" on public.wa_incidents for select using (true);

-- Service role can insert/update
create policy "Service insert health checks" on public.wa_health_checks for insert with check (true);
create policy "Service insert incidents" on public.wa_incidents for insert with check (true);
create policy "Service update incidents" on public.wa_incidents for update using (true);
