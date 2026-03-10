import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''
);

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { audio, conversationId, filename } = req.body;
    if (!audio) return res.status(400).json({ error: 'Audio data is required' });

    const buffer = Buffer.from(audio, 'base64');
    const name = filename || `voice-${Date.now()}.webm`;
    const path = `${conversationId || 'general'}/${name}`;

    await supabase.storage.createBucket('voice-messages', { public: true }).catch(() => undefined);

    const { data, error } = await supabase.storage
      .from('voice-messages')
      .upload(path, buffer, { contentType: 'audio/webm', upsert: true });

    if (error) {
      console.error('[upload-audio] Storage error:', error);
      return res.status(500).json({ error: error.message });
    }

    const { data: urlData } = supabase.storage.from('voice-messages').getPublicUrl(path);

    return res.status(200).json({ url: urlData.publicUrl, path });

  } catch (error: any) {
    console.error('[upload-audio] Error:', error.message || error);
    return res.status(500).json({ error: error.message || 'Upload failed' });
  }
}
