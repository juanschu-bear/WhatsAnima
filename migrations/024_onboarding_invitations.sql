-- Onboarding invitation flow

CREATE TABLE IF NOT EXISTS public.wa_invitations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  invite_code text UNIQUE NOT NULL,
  inviter_id uuid NOT NULL REFERENCES auth.users(id),
  invitee_name text NOT NULL,
  invitee_email text,
  allowed_avatars jsonb NOT NULL DEFAULT '[]'::jsonb,
  language text DEFAULT 'en',
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  created_at timestamptz DEFAULT now(),
  accepted_at timestamptz,
  expires_at timestamptz DEFAULT (now() + interval '7 days')
);

CREATE TABLE IF NOT EXISTS public.wa_user_avatar_access (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  owner_id uuid REFERENCES public.wa_owners(id) ON DELETE SET NULL,
  avatar_name text NOT NULL,
  granted_by uuid REFERENCES auth.users(id),
  invite_id uuid REFERENCES public.wa_invitations(id) ON DELETE SET NULL,
  granted_at timestamptz DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE(user_id, avatar_name)
);

CREATE TABLE IF NOT EXISTS public.wa_user_onboarding (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  avatar_name text NOT NULL,
  onboarding_completed boolean DEFAULT false,
  onboarding_session_id text,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, avatar_name)
);

ALTER TABLE public.wa_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_user_avatar_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_user_onboarding ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "invitations_owner_manage" ON public.wa_invitations;
CREATE POLICY "invitations_owner_manage" ON public.wa_invitations
  FOR ALL
  USING (auth.uid() = inviter_id)
  WITH CHECK (auth.uid() = inviter_id);

DROP POLICY IF EXISTS "invitations_public_read_active" ON public.wa_invitations;
CREATE POLICY "invitations_public_read_active" ON public.wa_invitations
  FOR SELECT
  USING (
    status = 'pending'
    AND expires_at > now()
  );

DROP POLICY IF EXISTS "avatar_access_user_read_own" ON public.wa_user_avatar_access;
CREATE POLICY "avatar_access_user_read_own" ON public.wa_user_avatar_access
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "avatar_access_owner_read" ON public.wa_user_avatar_access;
CREATE POLICY "avatar_access_owner_read" ON public.wa_user_avatar_access
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.wa_owners owners
      WHERE owners.id = wa_user_avatar_access.owner_id
        AND owners.user_id = auth.uid()
        AND owners.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "onboarding_user_read_own" ON public.wa_user_onboarding;
CREATE POLICY "onboarding_user_read_own" ON public.wa_user_onboarding
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "onboarding_user_update_own" ON public.wa_user_onboarding;
CREATE POLICY "onboarding_user_update_own" ON public.wa_user_onboarding
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_wa_invitations_invite_code ON public.wa_invitations(invite_code);
CREATE INDEX IF NOT EXISTS idx_wa_invitations_inviter_id ON public.wa_invitations(inviter_id);
CREATE INDEX IF NOT EXISTS idx_wa_user_avatar_access_user_id ON public.wa_user_avatar_access(user_id);
CREATE INDEX IF NOT EXISTS idx_wa_user_avatar_access_owner_id ON public.wa_user_avatar_access(owner_id);
CREATE INDEX IF NOT EXISTS idx_wa_user_onboarding_user_avatar ON public.wa_user_onboarding(user_id, avatar_name);
