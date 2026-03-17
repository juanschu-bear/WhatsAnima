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
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { client: supabase, missing } = getSupabaseAdmin()
  if (!supabase) {
    return res.status(503).json({ error: `DB not configured – missing ${missing}` })
  }

  try {
    const { data, error } = await supabase
      .from('wa_owners')
      .select('id, display_name')
      .is('deleted_at', null)
      .order('display_name', { ascending: true })

    if (error) {
      console.error('[list-owners] Query error:', error.message)
      return res.status(500).json({ error: error.message })
    }

    return res.status(200).json(data ?? [])
  } catch (err: any) {
    console.error('[list-owners] Error:', err.message || err)
    return res.status(500).json({ error: err.message || 'Failed to list owners' })
  }
}
