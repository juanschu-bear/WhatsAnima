import { getSupabaseAdmin, logLiveSessionEvent, normalizeBody } from './_lib/liveSessionAudit'

const LIVE_CALL_API_BASE =
  process.env.LIVE_CALL_API_BASE ||
  process.env.VITE_LIVE_CALL_API_BASE ||
  'https://anima.onioko.com'

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const body = normalizeBody(req)
  const sessionId = String(body.sessionId || '').trim()
  const endReason = String(body.reason || body.endReason || 'client_cleanup').trim()

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' })
  }

  const { client: supabase } = getSupabaseAdmin()
  const audit = async (status: 'ended' | 'end_failed', errorMessage?: string) => {
    if (!supabase) return
    try {
      await logLiveSessionEvent(supabase, {
        sessionId,
        conversationId: typeof body.conversationId === 'string' ? body.conversationId : null,
        ownerId: typeof body.ownerId === 'string' ? body.ownerId : null,
        personaName: typeof body.personaName === 'string' ? body.personaName : null,
        replicaId: typeof body.replicaId === 'string' ? body.replicaId : null,
        language: typeof body.language === 'string' ? body.language : null,
        joinUrl: typeof body.joinUrl === 'string' ? body.joinUrl : null,
        backendBaseUrl: LIVE_CALL_API_BASE,
        status,
        endReason,
        error: errorMessage ?? null,
      })
    } catch (error) {
      console.error('[live-session-end] audit failed', error)
    }
  }

  try {
    const response = await fetch(
      `${LIVE_CALL_API_BASE.replace(/\\/$/, '')}/api/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    )

    if (!response.ok && response.status !== 404) {
      const detail = await response.text()
      await audit('end_failed', detail)
      return res.status(502).json({ error: `Backend stop failed (${response.status})`, detail })
    }

    await audit('ended')
    return res.status(200).json({ ok: true, sessionId, status: response.status === 404 ? 'already_ended' : 'ended' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown stop error'
    await audit('end_failed', message)
    return res.status(502).json({ error: 'Failed to stop live session', detail: message })
  }
}
