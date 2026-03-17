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
    const [{ data: owners, error: ownersError }, { data: conversations, error: conversationsError }, { data: logs, error: logsError }] = await Promise.all([
      supabase
        .from('wa_owners')
        .select('id, display_name')
        .is('deleted_at', null)
        .order('display_name', { ascending: true }),
      supabase
        .from('wa_conversations')
        .select('id, owner_id, contact_id, created_at, updated_at'),
      supabase
        .from('wa_perception_logs')
        .select(`
          id,
          message_id,
          conversation_id,
          contact_id,
          owner_id,
          transcript,
          primary_emotion,
          secondary_emotion,
          recommended_tone,
          fired_rules,
          behavioral_summary,
          conversation_hooks,
          prosodic_summary,
          audio_duration_sec,
          facial_analysis,
          body_language,
          media_type,
          video_duration_sec,
          created_at
        `)
        .order('created_at', { ascending: false }),
    ])

    if (ownersError) throw ownersError
    if (conversationsError) throw conversationsError
    if (logsError) throw logsError

    const logRows = logs ?? []
    const messageIds = Array.from(new Set(logRows.map((log: any) => log.message_id).filter(Boolean)))
    const contactIds = Array.from(new Set((conversations ?? []).map((conversation: any) => conversation.contact_id).filter(Boolean)))

    const [{ data: messages, error: messagesError }, { data: contacts, error: contactsError }] = await Promise.all([
      messageIds.length === 0
        ? Promise.resolve({ data: [], error: null })
        : supabase
            .from('wa_messages')
            .select('id, media_url, duration_sec, type, content, created_at')
            .in('id', messageIds),
      contactIds.length === 0
        ? Promise.resolve({ data: [], error: null })
        : supabase
            .from('wa_contacts')
            .select('id, display_name, email')
            .in('id', contactIds),
    ])

    if (messagesError) throw messagesError
    if (contactsError) throw contactsError

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60')
    return res.status(200).json({
      owners: owners ?? [],
      conversations: conversations ?? [],
      contacts: contacts ?? [],
      messages: messages ?? [],
      logs: logRows,
    })
  } catch (error: any) {
    console.error('[perception-dashboard] failed', error?.message ?? error)
    return res.status(500).json({ error: error?.message || 'Failed to load perception dashboard data' })
  }
}
