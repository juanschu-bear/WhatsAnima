alter table public.wa_messages
  add column if not exists local_id uuid,
  add column if not exists transcript_interim text,
  add column if not exists transcript_final text,
  add column if not exists transcript_status text default 'pending',
  add column if not exists audio_status text default 'pending',
  add column if not exists audio_retry_count int default 0,
  add column if not exists audio_last_error text;

create index if not exists wa_messages_local_id_idx
  on public.wa_messages (local_id)
  where local_id is not null;
