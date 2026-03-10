import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const BUCKET = 'voice-messages'

function getSupabaseAdminClient(): { client: ReturnType<typeof createClient> | null; missing: string | null } {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const supabaseKey =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY

  if (!supabaseUrl) return { client: null, missing: 'SUPABASE_URL' }
  if (!supabaseKey) return { client: null, missing: 'SUPABASE_SERVICE_KEY' }
  return { client: createClient(supabaseUrl, supabaseKey), missing: null }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { client: supabase, missing } = getSupabaseAdminClient()
  if (!supabase) {
    return res.status(503).json({ error: `Storage not configured – missing env var ${missing}` })
  }

  // Accept both old field names (audio_base64, owner_id, conversation_id) and
  // new field names (audio, conversationId, filename) for backwards compat
  const body = req.body ?? {}
  const audioData = body.audio || body.audio_base64
  const convId = body.conversationId || body.conversation_id || 'general'
  const ownerId = body.owner_id || 'shared'
  const mimeType = body.mime_type || 'audio/webm'
  const filename = body.filename

  if (!audioData) {
    return res.status(400).json({ error: 'Audio data is required (send as "audio" or "audio_base64")' })
  }

  try {
    const audioBuffer = Buffer.from(audioData, 'base64')
    const ext = String(mimeType).includes('mpeg') ? 'mp3' : 'webm'
    const fileName = filename
      ? `${convId}/${filename}`
      : `${ownerId}/${convId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`
    const contentType = (mimeType || 'audio/webm').split(';')[0]

    await supabase.storage.createBucket(BUCKET, { public: true }).catch(() => undefined)

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .upload(fileName, audioBuffer, { contentType, upsert: true })

    if (error) {
      console.error('[upload-audio] Storage error:', error.message)
      return res.status(500).json({ error: 'Upload failed: ' + error.message })
    }

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(fileName)
    const publicUrl = urlData.publicUrl

    // Return both field names so both old and new frontends work
    return res.status(200).json({ url: publicUrl, audio_url: publicUrl, path: data?.path })
  } catch (error) {
    console.error('[upload-audio] Error:', error instanceof Error ? error.message : error)
    return res.status(500).json({
      error: 'Upload failed: ' + (error instanceof Error ? error.message : 'Unknown error'),
    })
  }
}
