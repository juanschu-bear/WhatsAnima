import { getSupabaseAdmin, normalizeBody } from './_lib/liveSessionAudit.js'

const LIVE_CALL_API_BASE =
  process.env.LIVE_CALL_API_BASE ||
  process.env.VITE_LIVE_CALL_API_BASE ||
  'https://anima.onioko.com'

const DAILY_API_BASE = 'https://api.daily.co/v1'

type RecordingAction = 'start' | 'stop'

function normalizeBackendBaseUrl(value: string) {
  return value.replace(/\/+$/, '').replace(/\/api$/, '')
}

function extractDailyRoomName(joinUrlRaw: string) {
  try {
    const url = new URL(joinUrlRaw)
    const path = url.pathname.replace(/^\/+/, '')
    const firstSegment = path.split('/').filter(Boolean)[0] || ''
    return firstSegment.trim()
  } catch {
    return ''
  }
}

async function safeJson(response: Response) {
  try {
    return await response.json()
  } catch {
    return {}
  }
}

function deriveRecordingUrl(payload: Record<string, any>) {
  return String(
    payload?.recording_url ||
      payload?.download_link ||
      payload?.share_link ||
      payload?.access_link ||
      payload?.url ||
      '',
  ).trim()
}

async function startDailyRecording(roomName: string, dailyApiKey: string) {
  const response = await fetch(`${DAILY_API_BASE}/rooms/${encodeURIComponent(roomName)}/recordings/start`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${dailyApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      start_cloud_recording: true,
    }),
  })
  const payload = await safeJson(response)
  if (!response.ok) {
    const detail = typeof payload?.error === 'string' ? payload.error : `Daily start failed (${response.status})`
    throw new Error(detail)
  }
  return payload
}

async function stopDailyRecording(roomName: string, dailyApiKey: string) {
  const response = await fetch(`${DAILY_API_BASE}/rooms/${encodeURIComponent(roomName)}/recordings/stop`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${dailyApiKey}`,
      'Content-Type': 'application/json',
    },
  })
  const payload = await safeJson(response)
  if (!response.ok) {
    const detail = typeof payload?.error === 'string' ? payload.error : `Daily stop failed (${response.status})`
    throw new Error(detail)
  }
  return payload
}

async function callBackendRecording(action: RecordingAction, backendBaseUrl: string, sessionId: string) {
  const variants = [
    `${backendBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/recording/${action}`,
    `${backendBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/recordings/${action}`,
  ]
  let lastError = 'Backend recording endpoint unavailable'
  for (const url of variants) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const payload = await safeJson(response)
      if (response.ok) return payload
      lastError = typeof payload?.error === 'string' ? payload.error : `Backend recording failed (${response.status})`
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Backend recording request failed'
    }
  }
  throw new Error(lastError)
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { client: supabase, missing } = getSupabaseAdmin()
  if (!supabase) {
    return res.status(500).json({ error: `Supabase admin unavailable (${missing || 'unknown'})` })
  }

  const body = normalizeBody(req)
  const action = String(body.action || '').trim().toLowerCase() as RecordingAction
  const meetingToken = String(body.meeting_token || body.meetingToken || '').trim()
  const sessionId = String(body.session_id || body.sessionId || '').trim()
  const joinUrl = String(body.join_url || body.joinUrl || '').trim()
  const backendBaseUrl = normalizeBackendBaseUrl(String(body.backendBaseUrl || LIVE_CALL_API_BASE))

  if (!meetingToken || !sessionId || !['start', 'stop'].includes(action)) {
    return res.status(400).json({ error: 'meeting_token, session_id and action(start|stop) are required' })
  }

  const { data: meeting, error: meetingError } = await supabase
    .from('wa_meeting_sessions')
    .select('id, token, expires_at, recording_url')
    .eq('token', meetingToken)
    .maybeSingle()

  if (meetingError) return res.status(500).json({ error: meetingError.message || 'Failed to load meeting session' })
  if (!meeting) return res.status(404).json({ error: 'Meeting not found' })
  if (meeting.expires_at && new Date(meeting.expires_at).getTime() < Date.now()) {
    return res.status(410).json({ error: 'Meeting has expired' })
  }

  const dailyApiKey = String(process.env.DAILY_API_KEY || '').trim()
  const roomName = extractDailyRoomName(joinUrl)

  try {
    let providerPayload: Record<string, any> = {}
    let provider: 'daily' | 'tavus' = 'tavus'

    if (dailyApiKey && roomName) {
      provider = 'daily'
      providerPayload =
        action === 'start'
          ? await startDailyRecording(roomName, dailyApiKey)
          : await stopDailyRecording(roomName, dailyApiKey)
    } else {
      provider = 'tavus'
      providerPayload = await callBackendRecording(action, backendBaseUrl, sessionId)
    }

    const recordingUrl = deriveRecordingUrl(providerPayload)
    const recordingId = String(providerPayload?.id || providerPayload?.recording_id || '').trim()

    if (action === 'stop') {
      const updatePayload: Record<string, unknown> = {
        status: 'ready',
      }
      if (recordingUrl) updatePayload.recording_url = recordingUrl
      const { error: updateError } = await supabase
        .from('wa_meeting_sessions')
        .update(updatePayload)
        .eq('id', meeting.id)
      if (updateError) {
        return res.status(500).json({ error: updateError.message || 'Failed to save recording URL' })
      }
    }

    return res.status(200).json({
      ok: true,
      provider,
      action,
      active: action === 'start',
      recording_id: recordingId || null,
      recording_url: action === 'stop' ? (recordingUrl || meeting.recording_url || null) : null,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown recording error'
    return res.status(502).json({ error: `Failed to ${action} recording`, detail })
  }
}
