import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

export const config = {
  api: { bodyParser: false }, // Handle raw body ourselves to support both FormData and JSON (avoids 4.5MB limit)
}

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

/**
 * Parse incoming request body — supports both:
 * 1. FormData with 'file' field (preferred, avoids Vercel 4.5MB JSON body limit)
 * 2. JSON with 'audio' base64 string (legacy fallback)
 */
async function parseRequestBody(req: any): Promise<{
  audioBuffer: Buffer
  conversationId: string
  mimeType: string
  filename?: string
  ownerId: string
}> {
  const ct = (req.headers['content-type'] || '').toLowerCase()

  // Read raw body
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  const rawBody = Buffer.concat(chunks)

  if (ct.includes('multipart/form-data')) {
    const boundaryMatch = ct.match(/boundary=(.+?)(?:;|$)/)
    if (!boundaryMatch) throw new Error('No boundary in multipart request')
    const boundary = boundaryMatch[1]
    const delimiter = Buffer.from(`--${boundary}`)
    const headerSep = Buffer.from('\r\n\r\n')

    let fileBuffer: Buffer | null = null
    let fileContentType = 'audio/webm'
    const fields: Record<string, string> = {}

    let pos = 0
    while (pos < rawBody.length) {
      const delimIdx = rawBody.indexOf(delimiter, pos)
      if (delimIdx === -1) break
      const partStart = delimIdx + delimiter.length + 2
      if (partStart >= rawBody.length) break
      const headerEndIdx = rawBody.indexOf(headerSep, partStart)
      if (headerEndIdx === -1) { pos = partStart; continue }
      const headers = rawBody.subarray(partStart, headerEndIdx).toString('utf-8')
      const dataStart = headerEndIdx + headerSep.length
      const nextDelim = rawBody.indexOf(delimiter, dataStart)
      const dataEnd = nextDelim !== -1 ? nextDelim - 2 : rawBody.length

      const nameMatch = headers.match(/name="([^"]+)"/)
      if (!nameMatch) { pos = partStart; continue }
      const fieldName = nameMatch[1]

      if (fieldName === 'file') {
        fileBuffer = rawBody.subarray(dataStart, dataEnd)
        const partCt = headers.match(/Content-Type:\s*(.+?)(?:\r\n|$)/i)?.[1]?.trim()
        if (partCt) fileContentType = partCt
      } else {
        fields[fieldName] = rawBody.subarray(dataStart, dataEnd).toString('utf-8').trim()
      }
      pos = dataStart
    }

    if (!fileBuffer) throw new Error('No file field in FormData')

    return {
      audioBuffer: fileBuffer,
      conversationId: fields.conversationId || fields.conversation_id || 'general',
      mimeType: fileContentType,
      filename: fields.filename || undefined,
      ownerId: fields.owner_id || 'shared',
    }
  }

  // JSON fallback (legacy base64 path)
  const body = JSON.parse(rawBody.toString('utf-8'))
  const audioData = body.audio || body.audio_base64
  if (!audioData) throw new Error('Audio data is required')

  return {
    audioBuffer: Buffer.from(audioData, 'base64'),
    conversationId: body.conversationId || body.conversation_id || 'general',
    mimeType: body.mime_type || 'audio/webm',
    filename: body.filename || undefined,
    ownerId: body.owner_id || 'shared',
  }
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

  try {
    const { audioBuffer, conversationId, mimeType, filename, ownerId } = await parseRequestBody(req)

    const ext = String(mimeType).includes('mpeg') ? 'mp3' : 'webm'
    const contentType = (mimeType || 'audio/webm').split(';')[0]
    const storagePath = filename
      ? `${conversationId}/${filename}`
      : `${ownerId}/${conversationId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`

    await supabase.storage.createBucket(BUCKET, { public: true }).catch(() => undefined)

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, audioBuffer, { contentType, upsert: true })

    if (error) {
      console.error('[upload-audio] Storage error:', error.message)
      return res.status(500).json({ error: 'Upload failed: ' + error.message })
    }

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(storagePath)
    const publicUrl = urlData.publicUrl

    return res.status(200).json({ url: publicUrl, audio_url: publicUrl, path: data?.path })
  } catch (error) {
    console.error('[upload-audio] Error:', error instanceof Error ? error.message : error)
    return res.status(500).json({
      error: 'Upload failed: ' + (error instanceof Error ? error.message : 'Unknown error'),
    })
  }
}
