create table if not exists public.wa_outbound_calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.wa_conversations(id) on delete cascade,
  owner_id uuid references public.wa_owners(id) on delete set null,
  contact_id uuid references public.wa_contacts(id) on delete set null,
  contact_email text not null,
  requested_by_message_id uuid references public.wa_messages(id) on delete set null,
  trigger_text text not null,
  mode text not null default 'video',
  status text not null default 'scheduled',
  caller_display_name text,
  requested_at timestamptz not null default now(),
  scheduled_for timestamptz not null,
  triggered_at timestamptz,
  accepted_at timestamptz,
  declined_at timestamptz,
  expires_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists wa_outbound_calls_contact_email_status_idx
  on public.wa_outbound_calls (contact_email, status, scheduled_for);

create index if not exists wa_outbound_calls_conversation_idx
  on public.wa_outbound_calls (conversation_id, requested_at desc);
