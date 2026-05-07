import { createHmac } from 'node:crypto'
import { getSupabaseAdmin, normalizeBody } from './_lib/liveSessionAudit.js'

type RecordingAction = 'start' | 'stop'

type CallRecordingPayload = {
  session_id: string
  conversation_id?: string | null
  owner_id?: string | null
  contact_id?: string | null
  user_id?: string | null
  avatar_name?: string | null
  user_name?: string | null
  started_at?: string | null
  ended_at?: string | null
  call_duration_seconds?: number | null
  transcript?: string | null
  meeting_token?: string | null
  recording_id?: string | null
}

type LivekitCredentials = {
  httpBase: string
  apiKey: string
  apiSecret: string
}

type S3RecordingConfig = {
  bucket: string
  region: string
  accessKey: string
  secret: string
  endpoint?: string
  forcePathStyle?: boolean
  publicBaseUrl?: string
}

function normalizeUrlBase(value: string) {
  return value.replace(/\/+$/, '')
}

function coerceString(value: unknown) {
  const out = String(value ?? '').trim()
  return out.length > 0 ? out : ''
}

function safeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function safeJsonDate(value: unknown): string | null {
  const raw = coerceString(value)
  if (!raw) return null
  const parsed = Date.parse(raw)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toISOString()
}

function parseLivekitJoinUrl(joinUrlRaw: string): { roomName: string; host: string } {
  const trimmed = coerceString(joinUrlRaw)
  if (!trimmed) return { roomName: '', host: '' }
  try {
    const normalized = trimmed.replace(/^livekit:\/\//i, 'https://')
    const url = new URL(normalized)
    const roomName = coerceString(url.searchParams.get('room'))
    return { roomName, host: coerceString(url.hostname) }
  } catch {
    return { roomName: '', host: '' }
  }
}

function resolveLivekitCredentials(joinUrl: string): LivekitCredentials | null {
  const envLivekitUrl = coerceString(process.env.LIVEKIT_URL || process.env.LIVEKIT_WS_URL)
  const envApiKey = coerceString(process.env.LIVEKIT_API_KEY)
  const envApiSecret = coerceString(process.env.LIVEKIT_API_SECRET)
  if (!envApiKey || !envApiSecret) return null

  let httpBase = ''
  const parsedJoin = parseLivekitJoinUrl(joinUrl)

  if (envLivekitUrl) {
    try {
      const normalized = envLivekitUrl.replace(/^wss?:\/\//i, 'https://')
      const url = new URL(normalized)
      httpBase = `${url.protocol}//${url.host}`
    } catch {
      httpBase = ''
    }
  }

  if (!httpBase && parsedJoin.host) {
    httpBase = `https://${parsedJoin.host}`
  }

  if (!httpBase) return null
  return {
    httpBase: normalizeUrlBase(httpBase),
    apiKey: envApiKey,
    apiSecret: envApiSecret,
  }
}

function resolveS3RecordingConfig(): S3RecordingConfig | null {
  const bucket = coerceString(process.env.LIVEKIT_RECORDING_S3_BUCKET)
  const region = coerceString(process.env.LIVEKIT_RECORDING_S3_REGION)
  const accessKey = coerceString(process.env.LIVEKIT_RECORDING_S3_ACCESS_KEY)
  const secret = coerceString(process.env.LIVEKIT_RECORDING_S3_SECRET_KEY)
  if (!bucket || !region || !accessKey || !secret) return null
  const endpoint = coerceString(process.env.LIVEKIT_RECORDING_S3_ENDPOINT) || undefined
  const forcePathStyleRaw = coerceString(process.env.LIVEKIT_RECORDING_S3_FORCE_PATH_STYLE).toLowerCase()
  const publicBaseUrl = coerceString(process.env.LIVEKIT_RECORDING_PUBLIC_BASE_URL) || undefined
  return {
    bucket,
    region,
    accessKey,
    secret,
    endpoint,
    publicBaseUrl,
    forcePathStyle: forcePathStyleRaw === 'true' || forcePathStyleRaw === '1',
  }
}

function toBase64Url(input: string | Buffer) {
  return Buffer.from(input).toString('base64url')
}

function createLivekitAccessToken(apiKey: string, apiSecret: string) {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const header = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = toBase64Url(
    JSON.stringify({
      iss: apiKey,
      sub: apiKey,
      iat: nowSeconds,
      nbf: nowSeconds - 5,
      exp: nowSeconds + 60 * 10,
      video: {
        roomRecord: true,
        roomAdmin: true,
      },
    }),
  )
  const unsigned = `${header}.${payload}`
  const signature = createHmac('sha256', apiSecret).update(unsigned).digest('base64url')
  return `${unsigned}.${signature}`
}

async function safeJson(response: Response) {
  try {
    return await response.json()
  } catch {
    return {}
  }
}

async function callLivekitEgress(
  credentials: LivekitCredentials,
  method: 'StartRoomCompositeEgress' | 'StopEgress',
  body: Record<string, unknown>,
) {
  const token = createLivekitAccessToken(credentials.apiKey, credentials.apiSecret)
  const response = await fetch(`${credentials.httpBase}/twirp/livekit.Egress/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const payload = await safeJson(response)
  if (!response.ok) {
    const detail = coerceString((payload as any)?.msg) || coerceString((payload as any)?.error) || `LiveKit egress failed (${response.status})`
    throw new Error(detail)
  }
  return payload as Record<string, unknown>
}

function deriveRecordingUrl(payload: Record<string, unknown>, fallbackPublicUrl?: string) {
  const direct =
    coerceString((payload as any)?.recording_url) ||
    coerceString((payload as any)?.download_link) ||
    coerceString((payload as any)?.share_link) ||
    coerceString((payload as any)?.access_link) ||
    coerceString((payload as any)?.url)
  if (direct) return direct

  const fileResult = Array.isArray((payload as any)?.fileResults) ? (payload as any).fileResults[0] : null
  const location = coerceString(fileResult?.location)
  if (location) return location

  if (fallbackPublicUrl) return fallbackPublicUrl
  return ''
}

function buildRecordingPath(sessionId: string, roomName: string) {
  const safeRoom = roomName.replace(/[^a-zA-Z0-9-_]/g, '_') || 'livekit-room'
  const safeSession = sessionId.replace(/[^a-zA-Z0-9-_]/g, '_') || 'session'
  return `call-recordings/${safeRoom}/${safeSession}-${Date.now()}.mp4`
}

function buildRecordingPublicUrl(config: S3RecordingConfig, path: string) {
  if (!config.publicBaseUrl) return ''
  return `${normalizeUrlBase(config.publicBaseUrl)}/${path.replace(/^\/+/, '')}`
}

async function upsertCallRecording(
  supabase: any,
  payload: CallRecordingPayload,
  action: RecordingAction,
  updates: {
    provider: string
    recordingStatus: string
    recordingId?: string | null
    recordingUrl?: string | null
    providerDetail?: string | null
  },
) {
  const baseRecord: Record<string, unknown> = {
    session_id: payload.session_id,
    conversation_id: payload.conversation_id || null,
    owner_id: payload.owner_id || null,
    contact_id: payload.contact_id || null,
    user_id: payload.user_id || null,
    avatar_name: payload.avatar_name || null,
    user_name: payload.user_name || null,
    meeting_token: payload.meeting_token || null,
    provider: updates.provider,
    recording_status: updates.recordingStatus,
    recording_id: updates.recordingId || null,
    recording_url: updates.recordingUrl || null,
    transcript: payload.transcript || null,
    started_at: payload.started_at || null,
    ended_at: payload.ended_at || null,
    call_duration_seconds: payload.call_duration_seconds ?? null,
    metadata: {
      provider_detail: updates.providerDetail || null,
      updated_at: new Date().toISOString(),
    },
  }

  const updatePayload: Record<string, unknown> = action === 'start'
    ? {
        ...baseRecord,
        started_at: payload.started_at || new Date().toISOString(),
      }
    : {
        ...baseRecord,
        ended_at: payload.ended_at || new Date().toISOString(),
      }

  const { error } = await (supabase as any)
    .from('wa_call_recordings')
    .upsert(updatePayload, { onConflict: 'session_id' })
  if (error) {
    throw new Error(error.message || 'Failed to persist call recording')
  }
}

async function getExistingRecording(supabase: any, sessionId: string) {
  const { data } = await (supabase as any)
    .from('wa_call_recordings')
    .select('recording_id, recording_url, started_at')
    .eq('session_id', sessionId)
    .maybeSingle()
  return (data || null) as { recording_id?: string | null; recording_url?: string | null; started_at?: string | null } | null
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
  const action = coerceString(body.action).toLowerCase() as RecordingAction
  const sessionId = coerceString(body.session_id || body.sessionId)
  const joinUrl = coerceString(body.join_url || body.joinUrl)
  const meetingToken = coerceString(body.meeting_token || body.meetingToken)

  if (!sessionId || !['start', 'stop'].includes(action)) {
    return res.status(400).json({ error: 'session_id and action(start|stop) are required' })
  }

  const callPayload: CallRecordingPayload = {
    session_id: sessionId,
    conversation_id: coerceString(body.conversation_id) || null,
    owner_id: coerceString(body.owner_id) || null,
    contact_id: coerceString(body.contact_id) || null,
    user_id: coerceString(body.user_id) || null,
    avatar_name: coerceString(body.avatar_name) || null,
    user_name: coerceString(body.user_name) || null,
    started_at: safeJsonDate(body.started_at),
    ended_at: safeJsonDate(body.ended_at),
    call_duration_seconds: safeNumber(body.call_duration_seconds),
    transcript: coerceString(body.transcript) || null,
    meeting_token: meetingToken || null,
    recording_id: coerceString(body.recording_id || body.recordingId) || null,
  }

  const { roomName } = parseLivekitJoinUrl(joinUrl)
  if (!roomName) {
    return res.status(400).json({
      error: 'This recorder only supports LiveKit sessions',
      detail: 'join_url is missing a livekit room parameter',
    })
  }

  const credentials = resolveLivekitCredentials(joinUrl)
  if (!credentials) {
    return res.status(500).json({
      error: 'LiveKit recording credentials missing',
      detail: 'Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET in Vercel env',
    })
  }

  try {
    let providerPayload: Record<string, unknown>
    let recordingId = callPayload.recording_id || ''
    let recordingUrl = ''
    let providerDetail = ''

    if (action === 'start') {
      const s3Config = resolveS3RecordingConfig()
      if (!s3Config) {
        return res.status(500).json({
          error: 'LiveKit recording storage missing',
          detail:
            'Set LIVEKIT_RECORDING_S3_BUCKET, LIVEKIT_RECORDING_S3_REGION, LIVEKIT_RECORDING_S3_ACCESS_KEY, LIVEKIT_RECORDING_S3_SECRET_KEY (optional: LIVEKIT_RECORDING_PUBLIC_BASE_URL)',
        })
      }

      const filePath = buildRecordingPath(sessionId, roomName)
      const startBody: Record<string, unknown> = {
        roomName,
        layout: 'speaker-light',
        fileOutputs: [
          {
            filepath: filePath,
            s3: {
              bucket: s3Config.bucket,
              region: s3Config.region,
              accessKey: s3Config.accessKey,
              secret: s3Config.secret,
              secretAccessKey: s3Config.secret,
              ...(s3Config.endpoint ? { endpoint: s3Config.endpoint } : {}),
              ...(typeof s3Config.forcePathStyle === 'boolean' ? { forcePathStyle: s3Config.forcePathStyle } : {}),
            },
          },
        ],
      }

      providerPayload = await callLivekitEgress(credentials, 'StartRoomCompositeEgress', startBody)
      recordingId = coerceString((providerPayload as any)?.egressId || (providerPayload as any)?.egress_id || recordingId)
      recordingUrl = deriveRecordingUrl(providerPayload, buildRecordingPublicUrl(s3Config, filePath))
      providerDetail = 'livekit_egress_start'
    } else {
      const existing = await getExistingRecording(supabase, sessionId)
      const stopEgressId = callPayload.recording_id || coerceString(existing?.recording_id)
      if (!stopEgressId) {
        return res.status(400).json({
          error: 'Missing recording_id',
          detail: 'No active recording found for this session to stop.',
        })
      }

      providerPayload = await callLivekitEgress(credentials, 'StopEgress', {
        egressId: stopEgressId,
      })
      recordingId = stopEgressId
      recordingUrl = deriveRecordingUrl(providerPayload, coerceString(existing?.recording_url))
      providerDetail = 'livekit_egress_stop'
    }

    if (action === 'stop' && meetingToken) {
      const { data: meetingData } = await (supabase as any)
        .from('wa_meeting_sessions')
        .select('id')
        .eq('token', meetingToken)
        .maybeSingle()
      if (meetingData?.id) {
        await (supabase as any)
          .from('wa_meeting_sessions')
          .update({ status: 'ready', recording_url: recordingUrl || null })
          .eq('id', meetingData.id)
      }
    }

    await upsertCallRecording(supabase, callPayload, action, {
      provider: 'livekit',
      recordingStatus: action === 'start' ? 'recording' : 'ready',
      recordingId: recordingId || null,
      recordingUrl: recordingUrl || null,
      providerDetail,
    })

    return res.status(200).json({
      ok: true,
      provider: 'livekit',
      action,
      active: action === 'start',
      recording_id: recordingId || null,
      recording_url: action === 'stop' ? (recordingUrl || null) : null,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown recording error'
    try {
      await upsertCallRecording(supabase, callPayload, action, {
        provider: 'livekit',
        recordingStatus: 'failed',
        recordingId: callPayload.recording_id || null,
        recordingUrl: null,
        providerDetail: detail,
      })
    } catch {
      // Ignore persistence errors while returning primary failure.
    }
    return res.status(502).json({ error: `Failed to ${action} recording`, detail })
  }
}
