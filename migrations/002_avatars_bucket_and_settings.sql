-- Create avatars storage bucket (public for read access)
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload avatars
CREATE POLICY "avatars_auth_insert" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'avatars' AND auth.role() = 'authenticated');

-- Allow authenticated users to update (upsert) their avatars
CREATE POLICY "avatars_auth_update" ON storage.objects
  FOR UPDATE USING (bucket_id = 'avatars' AND auth.role() = 'authenticated');

-- Allow public read access to avatars
CREATE POLICY "avatars_public_select" ON storage.objects
  FOR SELECT USING (bucket_id = 'avatars');

-- Allow authenticated users to delete their avatars
CREATE POLICY "avatars_auth_delete" ON storage.objects
  FOR DELETE USING (bucket_id = 'avatars' AND auth.role() = 'authenticated');

-- Add settings JSONB column to wa_owners for privacy/notification preferences
ALTER TABLE public.wa_owners
  ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}';
