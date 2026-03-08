-- WhatsAnima Database Schema
-- Run this in the Supabase SQL Editor for project: wofklmwbokdjoqlstjmy

-- Owners: the people who deploy their AI avatar
CREATE TABLE IF NOT EXISTS public.wa_owners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  voice_id TEXT,
  tavus_replica_id TEXT,
  opm_api_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Invitation links: unique links owners generate for contacts
CREATE TABLE IF NOT EXISTS public.wa_invitation_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES public.wa_owners(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL DEFAULT gen_random_uuid()::TEXT,
  label TEXT,
  max_uses INTEGER DEFAULT NULL,
  use_count INTEGER DEFAULT 0,
  expires_at TIMESTAMPTZ DEFAULT NULL,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Contacts: people who joined via invitation link
CREATE TABLE IF NOT EXISTS public.wa_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES public.wa_owners(id) ON DELETE CASCADE,
  invitation_id UUID REFERENCES public.wa_invitation_links(id),
  display_name TEXT,
  email TEXT,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  last_active_at TIMESTAMPTZ DEFAULT NOW()
);

-- Conversations: one thread per contact per owner
CREATE TABLE IF NOT EXISTS public.wa_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES public.wa_owners(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.wa_contacts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Messages: individual messages in each conversation
CREATE TABLE IF NOT EXISTS public.wa_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES public.wa_conversations(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('contact', 'avatar')),
  type TEXT NOT NULL CHECK (type IN ('text', 'voice', 'video', 'image')),
  content TEXT,
  media_url TEXT,
  duration_sec FLOAT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Perception logs: OPM analysis results per message
CREATE TABLE IF NOT EXISTS public.wa_perception_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID REFERENCES public.wa_messages(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES public.wa_conversations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.wa_contacts(id) ON DELETE CASCADE,
  owner_id UUID REFERENCES public.wa_owners(id) ON DELETE CASCADE,
  transcript TEXT,
  primary_emotion TEXT,
  secondary_emotion TEXT,
  fired_rules JSONB DEFAULT '[]'::jsonb,
  behavioral_summary TEXT,
  conversation_hooks JSONB DEFAULT '[]'::jsonb,
  recommended_tone TEXT,
  prosodic_summary JSONB DEFAULT NULL,
  audio_duration_sec FLOAT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on all tables
ALTER TABLE public.wa_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_invitation_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_perception_logs ENABLE ROW LEVEL SECURITY;

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';
