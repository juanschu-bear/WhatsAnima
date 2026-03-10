import { createClient } from '@supabase/supabase-js'

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY
  if (!url) return { client: null, missing: 'SUPABASE_URL' }
  if (!key) return { client: null, missing: 'SUPABASE_SERVICE_KEY' }
  return { client: createClient(url, key), missing: null }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { client: supabase, missing } = getSupabaseAdmin()
  if (!supabase) {
    return res.status(503).json({ error: `DB not configured – missing ${missing}` })
  }

  const {
    messageId,
    conversationId,
    contactId,
    ownerId,
    transcript,
    audioDurationSec,
  } = req.body ?? {}

  if (!conversationId || !contactId || !ownerId) {
    return res.status(400).json({ error: 'conversationId, contactId, and ownerId are required' })
  }

  try {
    const { data, error } = await supabase
      .from('wa_perception_logs')
      .insert({
        message_id: messageId ?? null,
        conversation_id: conversationId,
        contact_id: contactId,
        owner_id: ownerId,
        transcript: transcript ?? null,
        audio_duration_sec: audioDurationSec ?? null,
      })
      .select()
      .single()

    if (error) {
      console.error('[create-perception-log] Insert error:', error.message)
      return res.status(500).json({ error: error.message })
    }

    return res.status(200).json(data)
  } catch (err: any) {
    console.error('[create-perception-log] Error:', err.message || err)
    return res.status(500).json({ error: err.message || 'Failed to create perception log' })
  }
}
