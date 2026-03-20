ALTER TABLE wa_meeting_sessions
  ADD COLUMN IF NOT EXISTS recording_url TEXT;
