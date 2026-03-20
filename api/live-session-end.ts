import { getSupabaseAdmin, logLiveSessionEvent, normalizeBody } from './_lib/liveSessionAudit.js'

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
  const ownerId = typeof body.ownerId === 'string' ? body.ownerId.trim() : ''
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : ''
  const meetingToken = typeof body.meetingToken === 'string' ? body.meetingToken.trim() : ''
  const endReason = String(body.reason || body.endReason || 'client_cleanup').trim()

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' })
  }

  const { client: supabase } = getSupabaseAdmin()
  const audit = async (status: 'ended' | 'end_failed', currentSessionId: string, errorMessage?: string) => {
    if (!supabase) return
    try {
      await logLiveSessionEvent(supabase, {
        sessionId: currentSessionId,
        conversationId: conversationId || null,
        ownerId: ownerId || null,
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

  const stopSession = async (targetSessionId: string) => {
    const response = await fetch(
      `${LIVE_CALL_API_BASE.replace(/\/$/, '')}/api/sessions/${encodeURIComponent(targetSessionId)}`,
      { method: 'DELETE' },
    )
    if (!response.ok && response.status !== 404) {
      const detail = await response.text()
      throw new Error(`Backend stop failed (${response.status}) for ${targetSessionId}: ${detail}`)
    }
    return response.status
  }

  const resolveRelatedSessions = async () => {
    const sessions = new Set<string>([sessionId])
    if (!supabase) return sessions
    if (!ownerId && !conversationId) return sessions

    let query = supabase
      .from('wa_tavus_sessions')
      .select('session_id')
      .is('ended_at', null)
      .limit(25)

    if (ownerId) query = query.eq('owner_id', ownerId)
    if (conversationId) query = query.eq('conversation_id', conversationId)

    const { data, error } = await query
    if (error) {
      console.error('[live-session-end] related session query failed', error)
      return sessions
    }
    for (const row of data ?? []) {
      const candidate = String((row as { session_id?: string }).session_id || '').trim()
      if (candidate) sessions.add(candidate)
    }
    return sessions
  }

  try {
    const sessionsToStop = await resolveRelatedSessions()
    const failed: string[] = []

    for (const targetSessionId of sessionsToStop) {
      try {
        await stopSession(targetSessionId)
        await audit('ended', targetSessionId)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown stop error'
        failed.push(`${targetSessionId}: ${message}`)
        await audit('end_failed', targetSessionId, message)
      }
    }

    if (failed.length > 0) {
      return res.status(502).json({
        error: 'Failed to stop one or more live sessions',
        detail: failed.join(' | '),
      })
    }

    if (supabase && meetingToken) {
      const { error: meetingUpdateError } = await supabase
        .from('wa_meeting_sessions')
        .update({
          status: 'ended',
          live_session_id: null,
          live_join_url: null,
        })
        .eq('token', meetingToken)
      if (meetingUpdateError) {
        console.error('[live-session-end] failed to clear meeting live room fields', meetingUpdateError)
      }
    }

    return res.status(200).json({
      ok: true,
      sessionId,
      stoppedSessionIds: Array.from(sessionsToStop),
      status: 'ended',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown stop error'
    await audit('end_failed', sessionId, message)
    return res.status(502).json({ error: 'Failed to stop live session', detail: message })
  }
}
