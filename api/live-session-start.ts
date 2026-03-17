import { getSupabaseAdmin, logLiveSessionEvent, normalizeBody } from './_lib/liveSessionAudit'

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { client: supabase, missing } = getSupabaseAdmin()
  if (!supabase) {
    return res.status(503).json({ error: `DB not configured – missing ${missing}` })
  }

  const body = normalizeBody(req)
  const sessionId = String(body.sessionId || '').trim()

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' })
  }

  try {
    await logLiveSessionEvent(supabase, {
      sessionId,
      conversationId: typeof body.conversationId === 'string' ? body.conversationId : null,
      ownerId: typeof body.ownerId === 'string' ? body.ownerId : null,
      personaName: typeof body.personaName === 'string' ? body.personaName : null,
      replicaId: typeof body.replicaId === 'string' ? body.replicaId : null,
      language: typeof body.language === 'string' ? body.language : null,
      joinUrl: typeof body.joinUrl === 'string' ? body.joinUrl : null,
      backendBaseUrl: typeof body.backendBaseUrl === 'string' ? body.backendBaseUrl : null,
      status: 'started',
    })

    return res.status(200).json({ ok: true })
  } catch (error) {
    console.error('[live-session-start] failed', error)
    return res.status(500).json({ error: 'Failed to log live session start' })
  }
}
