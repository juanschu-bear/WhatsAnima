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

  const { messageIds } = req.body ?? {}
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return res.status(400).json({ error: 'messageIds array is required' })
  }

  try {
    const now = new Date().toISOString()
    const { error } = await supabase
      .from('wa_messages')
      .update({ read_at: now })
      .in('id', messageIds)
      .is('read_at', null)

    if (error) {
      console.error('[mark-read] Update error:', error.message)
      return res.status(500).json({ error: error.message })
    }

    return res.status(200).json({ ok: true, read_at: now })
  } catch (err: any) {
    console.error('[mark-read] Error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}
