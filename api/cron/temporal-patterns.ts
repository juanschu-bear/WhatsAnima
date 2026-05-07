import { createClient } from '@supabase/supabase-js'
import { computeTemporalPatternsForUser } from '../_lib/temporalIntelligence.js'

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

export default async function handler(req: any, res: any) {
  if (!['GET', 'HEAD', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, HEAD, POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const supabase = getSupabaseAdmin()
  if (!supabase) return res.status(200).json({ ok: false, skipped: true, reason: 'supabase_not_configured' })

  try {
    const { data: activeConversations } = await supabase
      .from('wa_conversations')
      .select('owner_id, contact_id, updated_at')
      .order('updated_at', { ascending: false })
      .limit(300)

    const pairs = new Map<string, { ownerId: string; contactId: string }>()
    for (const row of activeConversations || []) {
      const ownerId = String(row.owner_id || '').trim()
      const contactId = String(row.contact_id || '').trim()
      if (!ownerId || !contactId) continue
      const key = `${ownerId}:${contactId}`
      if (!pairs.has(key)) pairs.set(key, { ownerId, contactId })
    }

    let upserts = 0
    for (const pair of pairs.values()) {
      const patterns = await computeTemporalPatternsForUser({
        supabase,
        ownerId: pair.ownerId,
        userId: pair.contactId,
      })
      if (!patterns.length) continue

      for (const pattern of patterns) {
        await supabase.from('wa_temporal_patterns').insert(pattern)
        upserts += 1
      }
    }

    if (req.method === 'HEAD') return res.status(200).end()
    return res.status(200).json({
      ok: true,
      processed_pairs: pairs.size,
      inserted_patterns: upserts,
    })
  } catch (error: any) {
    console.error('[temporal-patterns] failed', error)
    if (req.method === 'HEAD') return res.status(200).end()
    return res.status(200).json({ ok: false, error: error?.message || String(error) })
  }
}
