CREATE TABLE IF NOT EXISTS public.wa_invitation_bundles (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  token text NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  owner_ids uuid[] NOT NULL,
  label text,
  max_uses integer,
  use_count integer DEFAULT 0,
  expires_at timestamptz,
  active boolean DEFAULT true,
  created_by uuid REFERENCES public.wa_owners(id),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.wa_invitation_bundles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bundle_owner_select" ON public.wa_invitation_bundles
  FOR SELECT USING (
    created_by IN (SELECT id FROM public.wa_owners WHERE user_id = auth.uid())
  );
CREATE POLICY "bundle_insert" ON public.wa_invitation_bundles
  FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "bundle_update" ON public.wa_invitation_bundles
  FOR UPDATE USING (TRUE);
CREATE POLICY "bundle_delete" ON public.wa_invitation_bundles
  FOR DELETE USING (TRUE);
CREATE POLICY "bundle_anon_select" ON public.wa_invitation_bundles
  FOR SELECT USING (active = true);
