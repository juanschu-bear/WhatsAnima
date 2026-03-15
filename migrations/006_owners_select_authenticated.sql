-- ============================================================
-- Migration 006: Allow authenticated users to read wa_owners
-- ============================================================
-- Without this policy, contacts (Avatar-Users) cannot see the list
-- of available avatars, and getConversation() cannot resolve the
-- owner display_name (falls back to 'Avatar').
--
-- Run this in the Supabase SQL Editor.

DROP POLICY IF EXISTS "owners_select_authenticated" ON public.wa_owners;
CREATE POLICY "owners_select_authenticated" ON public.wa_owners
  FOR SELECT USING (auth.uid() IS NOT NULL);

NOTIFY pgrst, 'reload schema';
