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

  // GET: list reactions for given message IDs
  if (req.method === 'GET') {
    const messageIds = req.query?.messageIds
    if (!messageIds) return res.status(200).json([])

    const ids = typeof messageIds === 'string' ? messageIds.split(',') : messageIds
    try {
      const { data, error } = await supabase
        .from('wa_reactions')
        .select('message_id, emoji, reactor')
        .in('message_id', ids)

      if (error) {
        // Table might not exist yet — return empty gracefully
        console.warn('[react-message] GET error (table may not exist):', error.message)
        return res.status(200).json([])
      }
      return res.status(200).json(data ?? [])
    } catch {
      return res.status(200).json([])
    }
  }

  if (req.method === 'POST') {
    const { messageId, emoji, reactor } = req.body ?? {}
    if (!messageId || !emoji || !reactor) {
      return res.status(400).json({ error: 'messageId, emoji, and reactor are required' })
    }

    try {
      const { data, error } = await supabase
        .from('wa_reactions')
        .upsert(
          { message_id: messageId, emoji, reactor },
          { onConflict: 'message_id,reactor' }
        )
        .select()
        .single()

      if (error) {
        // Table might not exist yet
        console.warn('[react-message] Upsert error (table may not exist):', error.message)
        return res.status(200).json({ ok: false, error: error.message })
      }
      return res.status(200).json(data)
    } catch (err: any) {
      console.warn('[react-message] Error:', err.message)
      return res.status(200).json({ ok: false, error: err.message })
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
        console.warn('[react-message] Delete error:', error.message)
        return res.status(200).json({ ok: false })
      }
      return res.status(200).json({ ok: true })
    } catch {
      return res.status(200).json({ ok: false })
    }
  }

  res.setHeader('Allow', 'GET, POST, DELETE')
  return res.status(405).json({ error: 'Method not allowed' })
}
