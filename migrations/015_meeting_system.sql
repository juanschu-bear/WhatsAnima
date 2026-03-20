CREATE TABLE IF NOT EXISTS wa_meeting_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES wa_owners(id),
  token TEXT UNIQUE NOT NULL,
  topic TEXT,
  participants JSONB DEFAULT '[]'::jsonb,
  status TEXT DEFAULT 'waiting',
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_wa_meeting_sessions_owner_id ON wa_meeting_sessions(owner_id);
CREATE INDEX IF NOT EXISTS idx_wa_meeting_sessions_status ON wa_meeting_sessions(status);
CREATE INDEX IF NOT EXISTS idx_wa_meeting_sessions_expires_at ON wa_meeting_sessions(expires_at);
