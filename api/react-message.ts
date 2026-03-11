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
  const { client: supabase, missing } = getSupabaseAdmin()
  if (!supabase) {
    return res.status(503).json({ error: `DB not configured – missing ${missing}` })
  }

  if (req.method === 'POST') {
    const { messageId, emoji, reactor } = req.body ?? {}
    if (!messageId || !emoji || !reactor) {
      return res.status(400).json({ error: 'messageId, emoji, and reactor are required' })
    }

    try {
      // Upsert: one reaction per message per reactor
      const { data, error } = await supabase
        .from('wa_reactions')
        .upsert(
          { message_id: messageId, emoji, reactor },
          { onConflict: 'message_id,reactor' }
        )
        .select()
        .single()

      if (error) {
        console.error('[react-message] Upsert error:', error.message)
        return res.status(500).json({ error: error.message })
      }
      return res.status(200).json(data)
    } catch (err: any) {
      console.error('[react-message] Error:', err.message)
      return res.status(500).json({ error: err.message })
    }
  }

  if (req.method === 'DELETE') {
    const { messageId, reactor } = req.body ?? {}
    if (!messageId || !reactor) {
      return res.status(400).json({ error: 'messageId and reactor are required' })
    }

    try {
      const { error } = await supabase
        .from('wa_reactions')
        .delete()
        .eq('message_id', messageId)
        .eq('reactor', reactor)

      if (error) {
        console.error('[react-message] Delete error:', error.message)
        return res.status(500).json({ error: error.message })
      }
      return res.status(200).json({ ok: true })
    } catch (err: any) {
      return res.status(500).json({ error: err.message })
    }
  }

  res.setHeader('Allow', 'POST, DELETE')
  return res.status(405).json({ error: 'Method not allowed' })
}
