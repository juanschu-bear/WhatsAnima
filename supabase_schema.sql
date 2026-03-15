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
  email TEXT,
  avatar_url TEXT,
  voice_id TEXT,
  system_prompt TEXT,
  tavus_replica_id TEXT,
  opm_api_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ DEFAULT NULL
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

-- Reactions: emoji reactions on messages
CREATE TABLE IF NOT EXISTS public.wa_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID REFERENCES public.wa_messages(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  reactor TEXT NOT NULL CHECK (reactor IN ('contact', 'avatar')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id, reactor)
);

ALTER TABLE public.wa_reactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "reactions_select" ON public.wa_reactions FOR SELECT USING (TRUE);
CREATE POLICY "reactions_insert" ON public.wa_reactions FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "reactions_update" ON public.wa_reactions FOR UPDATE USING (TRUE);
CREATE POLICY "reactions_delete" ON public.wa_reactions FOR DELETE USING (TRUE);

-- Message read status
ALTER TABLE public.wa_messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

-- Conversation memory: cross-session avatar memory
CREATE TABLE IF NOT EXISTS public.wa_conversation_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES public.wa_conversations(id) ON DELETE CASCADE UNIQUE,
  summary TEXT NOT NULL DEFAULT '',
  key_facts JSONB DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.wa_conversation_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "memory_select" ON public.wa_conversation_memory FOR SELECT USING (TRUE);
CREATE POLICY "memory_insert" ON public.wa_conversation_memory FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "memory_update" ON public.wa_conversation_memory FOR UPDATE USING (TRUE);

-- Behavioral memory: persistent OPM/Canon behavioral patterns (emotional, prosodic, topic reactions)
-- Stores how the user communicates, not what they say — extracted from real audio/video analysis
ALTER TABLE public.wa_conversation_memory
  ADD COLUMN IF NOT EXISTS behavioral_profile JSONB DEFAULT '{}'::jsonb;

-- Owner persona learning: flag whether owner IS the avatar (self-clone)
-- When true, the system learns the owner's communication style from conversations
-- When false (e.g. a celebrity avatar), only OPM adapts behavior to the contact
ALTER TABLE public.wa_owners
  ADD COLUMN IF NOT EXISTS is_self_avatar BOOLEAN DEFAULT FALSE;

-- Stores extracted communication style patterns (only used when is_self_avatar = true)
-- Example: {"traits": ["Uses humor and irony", "Switches between German and Spanish"], "speech_patterns": ["Says 'mega' and 'krass'"], "thinking_style": ["Asks counter-questions"]}
ALTER TABLE public.wa_owners
  ADD COLUMN IF NOT EXISTS communication_style JSONB DEFAULT NULL;

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

-- Ensure email column exists on contacts for email-verified invites
ALTER TABLE public.wa_contacts
  ADD COLUMN IF NOT EXISTS email TEXT;

-- Ensure email column exists on owners for email-based auth matching
ALTER TABLE public.wa_owners
  ADD COLUMN IF NOT EXISTS email TEXT;

-- Allow authenticated users to claim an owner record that matches their email
-- (handles auth method migration, e.g. phone → email)
DROP POLICY IF EXISTS "owners_claim_by_email" ON public.wa_owners;
CREATE POLICY "owners_claim_by_email" ON public.wa_owners
  FOR UPDATE USING (
    email IS NOT NULL
    AND email = (SELECT au.email FROM auth.users au WHERE au.id = auth.uid())
  );

-- Also allow selecting owner by email so the fallback query works
DROP POLICY IF EXISTS "owners_select_by_email" ON public.wa_owners;
CREATE POLICY "owners_select_by_email" ON public.wa_owners
  FOR SELECT USING (
    email IS NOT NULL
    AND email = (SELECT au.email FROM auth.users au WHERE au.id = auth.uid())
  );

-- Allow any authenticated user to read all owners (needed for orphan-claim fallback)
DROP POLICY IF EXISTS "owners_select_authenticated" ON public.wa_owners;
CREATE POLICY "owners_select_authenticated" ON public.wa_owners
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- Allow any authenticated user to claim an orphaned owner record
-- (owner whose user_id doesn't match any active session)
DROP POLICY IF EXISTS "owners_claim_orphan" ON public.wa_owners;
CREATE POLICY "owners_claim_orphan" ON public.wa_owners
  FOR UPDATE USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() = user_id);

-- =============================================================
-- Canon: Personal Voice Baseline (5-Tier Calibration System)
-- =============================================================
-- Stores the calibrated personal audio baseline per contact+owner pair.
-- Baseline is recalculated from ALL data at each tier advancement.
--
-- Tier 0: building       (< 60s)       — collecting, no baseline
-- Tier 1: snapshot       (≥ 60s)       — first glimpse, ~15% confidence
-- Tier 2: session        (≥ 30min)     — session stability, ~40% confidence
-- Tier 3: short_term     (≥ 60min)     — daily pattern, ~60% confidence
-- Tier 4: established    (≥ 180min)    — real tendency, ~80% confidence
-- Tier 5: deep           (≥ 600min)    — long-term profile, ~95% confidence

CREATE TABLE IF NOT EXISTS public.wa_voice_baseline (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES public.wa_contacts(id) ON DELETE CASCADE,
  owner_id UUID REFERENCES public.wa_owners(id) ON DELETE CASCADE,
  current_tier INTEGER NOT NULL DEFAULT 0,
  tier_name TEXT NOT NULL DEFAULT 'building',
  confidence FLOAT NOT NULL DEFAULT 0,
  cumulative_audio_sec FLOAT NOT NULL DEFAULT 0,
  baseline_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- baseline_data structure:
  -- {
  --   "prosodic_center": {
  --     "mean_pitch": 185.2,       -- Hz, avg fundamental frequency
  --     "pitch_range": 45.3,       -- Hz, high-low difference
  --     "pitch_variability": 12.1, -- Hz, std deviation
  --     "speaking_rate": 4.2,      -- words/sec
  --     "articulation_rate": 5.1,  -- syllables/sec (excl. pauses)
  --     "pause_count": 3.5,        -- avg pauses per message
  --     "mean_pause_duration": 0.42,-- seconds
  --     "pause_ratio": 0.18,       -- proportion silence
  --     "volume_mean": -22.5,      -- dB, avg loudness
  --     "volume_range": 15.3,      -- dB, dynamic range
  --     "volume_variability": 4.2, -- dB, std deviation
  --     "jitter": 0.012,           -- pitch cycle variation
  --     "shimmer": 0.034,          -- amplitude cycle variation
  --     "harmonic_to_noise_ratio": 18.5 -- dB, voice clarity
  --   },
  --   "emotion_distribution": {
  --     "engaged": 0.45,
  --     "calm": 0.30,
  --     "amused": 0.15,
  --     "contemplative": 0.10
  --   },
  --   "sample_count": 5,
  --   "prosodic_sample_count": 4
  -- }
  sample_count INTEGER NOT NULL DEFAULT 0,
  locked_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(contact_id, owner_id)
);

ALTER TABLE public.wa_voice_baseline ENABLE ROW LEVEL SECURITY;

-- Owners can read baselines for their contacts
CREATE POLICY "baseline_owner_select" ON public.wa_voice_baseline
  FOR SELECT USING (
    owner_id IN (SELECT id FROM public.wa_owners WHERE user_id = auth.uid())
  );
-- Service key handles inserts (from API)
CREATE POLICY "baseline_insert" ON public.wa_voice_baseline
  FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "baseline_update" ON public.wa_voice_baseline
  FOR UPDATE USING (TRUE);

-- =============================================================
-- Reminders: proactive avatar nudges from timeline memory
-- =============================================================
-- Extracted during session-end memory update when the user mentions
-- future events, deadlines, or tasks. The avatar proactively reminds them.

CREATE TABLE IF NOT EXISTS public.wa_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES public.wa_conversations(id) ON DELETE CASCADE,
  reminder_text TEXT NOT NULL,
  source_fact TEXT,
  due_at TIMESTAMPTZ NOT NULL,
  fired BOOLEAN DEFAULT FALSE,
  fired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reminders_due
  ON public.wa_reminders (conversation_id, fired, due_at);

ALTER TABLE public.wa_reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "reminders_select" ON public.wa_reminders FOR SELECT USING (TRUE);
CREATE POLICY "reminders_insert" ON public.wa_reminders FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "reminders_update" ON public.wa_reminders FOR UPDATE USING (TRUE);

-- =============================================================
-- Flashcards: extend message type to support interactive cards
-- =============================================================
-- Add 'flashcard' as a valid message type
ALTER TABLE public.wa_messages DROP CONSTRAINT IF EXISTS wa_messages_type_check;
ALTER TABLE public.wa_messages ADD CONSTRAINT wa_messages_type_check
  CHECK (type IN ('text', 'voice', 'video', 'image', 'flashcard'));

-- =============================================================
-- Push Subscriptions: Web Push endpoints per user
-- =============================================================
CREATE TABLE IF NOT EXISTS public.wa_push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL DEFAULT '',
  auth TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(endpoint)
);

ALTER TABLE public.wa_push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "push_select" ON public.wa_push_subscriptions FOR SELECT USING (TRUE);
CREATE POLICY "push_insert" ON public.wa_push_subscriptions FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "push_update" ON public.wa_push_subscriptions FOR UPDATE USING (TRUE);
CREATE POLICY "push_delete" ON public.wa_push_subscriptions FOR DELETE USING (TRUE);

NOTIFY pgrst, 'reload schema';
