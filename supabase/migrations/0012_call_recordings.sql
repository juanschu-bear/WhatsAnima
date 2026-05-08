create table if not exists public.wa_call_recordings (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique,
  conversation_id uuid references public.wa_conversations(id) on delete set null,
  owner_id uuid references public.wa_owners(id) on delete set null,
  contact_id uuid references public.wa_contacts(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  meeting_token text,
  avatar_name text,
  user_name text,
  provider text not null default 'livekit',
  recording_status text not null default 'recording',
  recording_id text,
  recording_url text,
  transcript text,
  started_at timestamptz,
  ended_at timestamptz,
  call_duration_seconds integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists wa_call_recordings_owner_created_idx
  on public.wa_call_recordings (owner_id, created_at desc);

create index if not exists wa_call_recordings_contact_created_idx
  on public.wa_call_recordings (contact_id, created_at desc);

create index if not exists wa_call_recordings_status_created_idx
  on public.wa_call_recordings (recording_status, created_at desc);
