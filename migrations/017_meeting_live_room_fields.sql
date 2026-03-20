ALTER TABLE wa_meeting_sessions
  ADD COLUMN IF NOT EXISTS live_session_id TEXT,
  ADD COLUMN IF NOT EXISTS live_join_url TEXT,
  ADD COLUMN IF NOT EXISTS live_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_wa_meeting_sessions_live_session_id
  ON wa_meeting_sessions(live_session_id);
