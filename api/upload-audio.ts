import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const BUCKET = 'voice-messages'

function getSupabaseAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const supabaseKey =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY

  if (!supabaseUrl || !supabaseKey) return null
  return createClient(supabaseUrl, supabaseKey)
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const supabase = getSupabaseAdminClient()
  if (!supabase) {
    return res.status(503).json({ error: 'Storage not configured' })
  }

  const { audio_base64, owner_id, conversation_id, mime_type } = req.body ?? {}
  if (!audio_base64 || !owner_id || !conversation_id) {
    return res.status(400).json({ error: 'Missing required fields: audio_base64, owner_id, conversation_id' })
  }

  try {
    const audioBuffer = Buffer.from(audio_base64, 'base64')
    const ext = String(mime_type || 'audio/webm').includes('mpeg') ? 'mp3' : 'webm'
    const fileName = `${owner_id}/${conversation_id}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`
    const contentType = mime_type || 'audio/webm'

    const { data: bucketData, error: bucketError } = await supabase.storage.createBucket(BUCKET, {
      public: true,
      allowedMimeTypes: ['audio/webm', 'audio/mpeg', 'audio/mp4', 'audio/ogg'],
      fileSizeLimit: 5 * 1024 * 1024,
    })
    if (bucketError) {
      console.log('[UploadAudio] createBucket result:', bucketError.message, '(expected if bucket already exists)')
    } else {
      console.log('[UploadAudio] createBucket success:', JSON.stringify(bucketData))
    }

    console.log('[UploadAudio] Uploading file:', fileName, 'size:', audioBuffer.length, 'contentType:', contentType)

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .upload(fileName, audioBuffer, {
        contentType,
        upsert: false,
      })

    console.log('[UploadAudio] Upload response — data:', JSON.stringify(data), 'error:', error ? JSON.stringify({ message: error.message, statusCode: (error as any).statusCode, error: (error as any).error }) : 'null')

    if (error) {
      console.error('[UploadAudio] Storage upload FAILED:', 'message:', error.message, 'statusCode:', (error as any).statusCode, 'error:', (error as any).error, 'full:', JSON.stringify(error))
      return res.status(500).json({ error: 'Upload failed: ' + error.message })
    }

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(fileName)
    console.log('[UploadAudio] Upload SUCCESS — path:', data?.path, 'publicUrl:', urlData.publicUrl)

    return res.status(200).json({ audio_url: urlData.publicUrl })
  } catch (error) {
    console.error('[UploadAudio] Error:', error instanceof Error ? error.message : error)
    return res.status(500).json({
      error: 'Upload failed: ' + (error instanceof Error ? error.message : 'Unknown error'),
    })
  }
}
