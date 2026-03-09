-- WhatsAnima Database Schema
-- Run this in the Supabase SQL Editor for project: wofklmwbokdjoqlstjmy

-- Owners: the people who deploy their AI avatar
CREATE TABLE IF NOT EXISTS public.wa_owners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  phone_number TEXT,
  avatar_url TEXT,
  voice_id TEXT,
  system_prompt TEXT,
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
  first_name TEXT,
  last_name TEXT,
  phone_number TEXT,
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

-- ============================================================
-- RLS Policies
-- ============================================================

-- wa_owners: authenticated users can manage their own row
CREATE POLICY "owners_select_own" ON public.wa_owners
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "owners_insert_own" ON public.wa_owners
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "owners_update_own" ON public.wa_owners
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "owners_public_for_active_links" ON public.wa_owners
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM public.wa_invitation_links links
      WHERE links.owner_id = public.wa_owners.id
        AND links.active = TRUE
    )
  );

-- wa_invitation_links: owners manage their own links, anyone can read active links (for /invite/:token)
CREATE POLICY "links_owner_all" ON public.wa_invitation_links
  FOR ALL USING (
    owner_id IN (SELECT id FROM public.wa_owners WHERE user_id = auth.uid())
  );
CREATE POLICY "links_public_read_active" ON public.wa_invitation_links
  FOR SELECT USING (active = TRUE);
CREATE POLICY "links_public_update_usage" ON public.wa_invitation_links
  FOR UPDATE USING (active = TRUE)
  WITH CHECK (active = TRUE);

-- wa_contacts: owners see their contacts, anon users can insert (when joining via invite)
CREATE POLICY "contacts_owner_select" ON public.wa_contacts
  FOR SELECT USING (
    owner_id IN (SELECT id FROM public.wa_owners WHERE user_id = auth.uid())
  );
CREATE POLICY "contacts_public_for_conversations" ON public.wa_contacts
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM public.wa_conversations conversations
      WHERE conversations.contact_id = public.wa_contacts.id
    )
  );
CREATE POLICY "contacts_insert" ON public.wa_contacts
  FOR INSERT WITH CHECK (TRUE);

-- wa_conversations: owners see their conversations, contacts can read their own
CREATE POLICY "conversations_owner" ON public.wa_conversations
  FOR ALL USING (
    owner_id IN (SELECT id FROM public.wa_owners WHERE user_id = auth.uid())
  );
CREATE POLICY "conversations_public_read" ON public.wa_conversations
  FOR SELECT USING (TRUE);
CREATE POLICY "conversations_insert" ON public.wa_conversations
  FOR INSERT WITH CHECK (TRUE);

ALTER TABLE public.wa_owners
  ADD COLUMN IF NOT EXISTS system_prompt TEXT;
ALTER TABLE public.wa_owners
  ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE public.wa_owners
  ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE public.wa_owners
  ADD COLUMN IF NOT EXISTS phone_number TEXT;
ALTER TABLE public.wa_contacts
  ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE public.wa_contacts
  ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE public.wa_contacts
  ADD COLUMN IF NOT EXISTS phone_number TEXT;

DROP POLICY IF EXISTS "owners_public_for_active_links" ON public.wa_owners;
CREATE POLICY "owners_public_for_active_links" ON public.wa_owners
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM public.wa_invitation_links links
      WHERE links.owner_id = public.wa_owners.id
        AND links.active = TRUE
    )
  );

-- wa_messages: anyone in the conversation can read/write messages
CREATE POLICY "messages_select" ON public.wa_messages
  FOR SELECT USING (TRUE);
CREATE POLICY "messages_insert" ON public.wa_messages
  FOR INSERT WITH CHECK (TRUE);

-- wa_perception_logs: owners can read their own logs
CREATE POLICY "perception_owner_select" ON public.wa_perception_logs
  FOR SELECT USING (
    owner_id IN (SELECT id FROM public.wa_owners WHERE user_id = auth.uid())
  );
CREATE POLICY "perception_insert" ON public.wa_perception_logs
  FOR INSERT WITH CHECK (TRUE);

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';

-- Incremental policy patch for existing projects
DROP POLICY IF EXISTS "contacts_insert" ON public.wa_contacts;
CREATE POLICY "contacts_insert" ON public.wa_contacts
  FOR INSERT WITH CHECK (TRUE);

DROP POLICY IF EXISTS "contacts_public_for_conversations" ON public.wa_contacts;
CREATE POLICY "contacts_public_for_conversations" ON public.wa_contacts
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM public.wa_conversations conversations
      WHERE conversations.contact_id = public.wa_contacts.id
    )
  );

DROP POLICY IF EXISTS "conversations_insert" ON public.wa_conversations;
CREATE POLICY "conversations_insert" ON public.wa_conversations
  FOR INSERT WITH CHECK (TRUE);

DROP POLICY IF EXISTS "links_public_update_usage" ON public.wa_invitation_links;
CREATE POLICY "links_public_update_usage" ON public.wa_invitation_links
  FOR UPDATE USING (active = TRUE)
  WITH CHECK (active = TRUE);
