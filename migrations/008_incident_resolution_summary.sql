-- Add resolution_summary to incidents for post-mortem details
alter table public.wa_incidents add column if not exists resolution_summary text;
