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
    conversationId,
    sender,
    type,
    content,
    mediaUrl,
    durationSec,
  } = req.body ?? {}

  if (!conversationId || !sender || !type) {
    return res.status(400).json({ error: 'conversationId, sender, and type are required' })
  }

  try {
    // Insert message
    const { data, error } = await supabase
      .from('wa_messages')
      .insert({
        conversation_id: conversationId,
        sender,
        type,
        content: content ?? null,
        media_url: mediaUrl ?? null,
        duration_sec: durationSec ?? null,
      })
      .select()
      .single()

    if (error) {
      console.error('[send-message] Insert error:', error.message)
      return res.status(500).json({ error: error.message })
    }

    // Update conversation timestamp
    const { error: updateError } = await supabase
      .from('wa_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId)

    if (updateError) {
      console.error('[send-message] Conversation update error:', updateError.message)
      // Don't fail the whole request for this — message was already inserted
    }

    return res.status(200).json(data)
  } catch (err: any) {
    console.error('[send-message] Error:', err.message || err)
    return res.status(500).json({ error: err.message || 'Failed to send message' })
  }
}
