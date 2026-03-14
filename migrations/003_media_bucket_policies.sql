-- Create media storage buckets (public for read access)
INSERT INTO storage.buckets (id, name, public)
VALUES
  ('voice-messages', 'voice-messages', true),
  ('image-uploads', 'image-uploads', true),
  ('video-uploads', 'video-uploads', true),
  ('video-messages', 'video-messages', true)
ON CONFLICT (id) DO NOTHING;

-- voice-messages: allow anyone (anon + authenticated) to upload and read
CREATE POLICY "voice_messages_insert" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'voice-messages');

CREATE POLICY "voice_messages_update" ON storage.objects
  FOR UPDATE USING (bucket_id = 'voice-messages');

CREATE POLICY "voice_messages_select" ON storage.objects
  FOR SELECT USING (bucket_id = 'voice-messages');

-- image-uploads: allow anyone to upload and read
CREATE POLICY "image_uploads_insert" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'image-uploads');

CREATE POLICY "image_uploads_update" ON storage.objects
  FOR UPDATE USING (bucket_id = 'image-uploads');

CREATE POLICY "image_uploads_select" ON storage.objects
  FOR SELECT USING (bucket_id = 'image-uploads');

-- video-uploads: allow anyone to upload and read
CREATE POLICY "video_uploads_insert" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'video-uploads');

CREATE POLICY "video_uploads_update" ON storage.objects
  FOR UPDATE USING (bucket_id = 'video-uploads');

CREATE POLICY "video_uploads_select" ON storage.objects
  FOR SELECT USING (bucket_id = 'video-uploads');

-- video-messages: allow anyone to upload and read
CREATE POLICY "video_messages_insert" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'video-messages');

CREATE POLICY "video_messages_update" ON storage.objects
  FOR UPDATE USING (bucket_id = 'video-messages');

CREATE POLICY "video_messages_select" ON storage.objects
  FOR SELECT USING (bucket_id = 'video-messages');
