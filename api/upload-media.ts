import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''
);

export const config = { api: { bodyParser: { sizeLimit: '50mb' } } };

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { file, conversationId, filename, contentType, bucket } = req.body;
    if (!file) return res.status(400).json({ error: 'File data is required' });

    const buffer = Buffer.from(file, 'base64');
    const storageBucket = bucket || 'image-uploads';
    const name = filename || `media-${Date.now()}`;
    const path = `${conversationId || 'general'}/${name}`;

    const { data, error } = await supabase.storage
      .from(storageBucket)
      .upload(path, buffer, { contentType: contentType || 'application/octet-stream', upsert: true });

    if (error) {
      console.error('[upload-media] Storage error:', error);
      return res.status(500).json({ error: error.message });
    }

    const { data: urlData } = supabase.storage.from(storageBucket).getPublicUrl(path);

    return res.status(200).json({ url: urlData.publicUrl, path });

  } catch (error: any) {
    console.error('[upload-media] Error:', error.message || error);
    return res.status(500).json({ error: error.message || 'Upload failed' });
  }
}
