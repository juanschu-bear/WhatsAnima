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

// Expected columns per table — add new columns here when schema changes
const EXPECTED_SCHEMA: Record<string, string[]> = {
  wa_owners: [
    'id', 'user_id', 'display_name', 'email', 'voice_id', 'system_prompt',
    'tavus_replica_id', 'opm_api_url', 'is_self_avatar', 'communication_style',
    'deleted_at', 'created_at', 'updated_at',
  ],
  wa_messages: [
    'id', 'conversation_id', 'sender', 'type', 'content',
    'media_url', 'duration_sec', 'read_at', 'created_at',
  ],
  wa_perception_logs: [
    'id', 'message_id', 'conversation_id', 'contact_id', 'owner_id',
    'transcript', 'primary_emotion', 'secondary_emotion',
    'behavioral_summary', 'conversation_hooks', 'fired_rules',
    'recommended_tone', 'prosodic_summary', 'audio_duration_sec', 'created_at',
  ],
  wa_voice_baseline: [
    'id', 'contact_id', 'owner_id', 'current_tier', 'tier_name',
    'confidence', 'cumulative_audio_sec', 'baseline_data',
    'sample_count', 'locked_at', 'updated_at',
  ],
}

type CheckResult = {
  status: 'ok' | 'fail' | 'degraded'
  message?: string
  details?: any
  response_time_ms?: number
}

async function checkDbSchema(supabase: any): Promise<CheckResult> {
  const missing: Record<string, string[]> = {}

  for (const [table, expectedCols] of Object.entries(EXPECTED_SCHEMA)) {
    try {
      // Select a single row to discover columns — works even on empty tables
      const { data, error } = await supabase
        .from(table)
        .select(expectedCols.join(','))
        .limit(0)

      if (error) {
        // Parse which columns are actually missing from the error message
        const msg = error.message || ''
        if (msg.includes('does not exist') || msg.includes('relation')) {
          missing[table] = ['TABLE_MISSING']
        } else {
          // Try individual columns to find the missing ones
          const tableMissing: string[] = []
          for (const col of expectedCols) {
            const { error: colErr } = await supabase
              .from(table)
              .select(col)
              .limit(0)
            if (colErr) tableMissing.push(col)
          }
          if (tableMissing.length > 0) missing[table] = tableMissing
        }
      }
    } catch (err: any) {
      missing[table] = ['QUERY_ERROR: ' + (err.message || String(err))]
    }
  }

  const hasMissing = Object.keys(missing).length > 0
  return {
    status: hasMissing ? 'fail' : 'ok',
    message: hasMissing ? 'Missing columns detected' : 'All expected columns present',
    ...(hasMissing && { details: missing }),
  }
}

async function checkOpm(): Promise<CheckResult> {
  const url = 'https://opm.onioko.com/health'
  try {
    const resp = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    })
    if (resp.ok) {
      return { status: 'ok', message: `OPM reachable (${resp.status})` }
    }
    const body = await resp.text().catch(() => '')
    return {
      status: 'fail',
      message: `OPM returned ${resp.status}`,
      details: body.slice(0, 500),
    }
  } catch (err: any) {
    return {
      status: 'fail',
      message: 'OPM unreachable',
      details: err.message || String(err),
    }
  }
}

async function checkAuth(): Promise<CheckResult> {
  const { client, missing } = getSupabaseAdmin()
  if (!client) {
    return { status: 'fail', message: `Missing env var: ${missing}` }
  }
  try {
    // Lightweight query to verify the connection works
    const { error } = await client.from('wa_owners').select('id').limit(1)
    if (error) {
      return { status: 'fail', message: 'Supabase query failed', details: error.message }
    }
    return { status: 'ok', message: 'Supabase service key connection works' }
  } catch (err: any) {
    return { status: 'fail', message: 'Supabase connection error', details: err.message }
  }
}

async function checkTts(): Promise<CheckResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY || process.env.VITE_ELEVENLABS_API_KEY
  if (!apiKey) {
    return { status: 'fail', message: 'Missing ELEVENLABS_API_KEY' }
  }
  try {
    // Hit the user endpoint — lightweight authenticated check
    const resp = await fetch('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(10_000),
    })
    if (resp.ok) {
      return { status: 'ok', message: 'ElevenLabs API reachable and authenticated' }
    }
    return {
      status: 'fail',
      message: `ElevenLabs returned ${resp.status}`,
      details: resp.status === 401 ? 'Invalid API key' : await resp.text().catch(() => ''),
    }
  } catch (err: any) {
    return {
      status: 'fail',
      message: 'ElevenLabs unreachable',
      details: err.message || String(err),
    }
  }
}

async function checkChatApi(baseUrl: string): Promise<CheckResult> {
  try {
    const resp = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    })
    // We expect 400/422 (missing params) — that still proves the endpoint is reachable
    if (resp.status < 500) {
      return { status: 'ok', message: `Chat API reachable (${resp.status})` }
    }
    return { status: 'fail', message: `Chat API returned ${resp.status}` }
  } catch (err: any) {
    return {
      status: 'fail',
      message: 'Chat API unreachable',
      details: err.message || String(err),
    }
  }
}

async function checkTranscription(): Promise<CheckResult> {
  const apiKey = process.env.DEEPGRAM_API_KEY
  if (!apiKey) {
    return { status: 'fail', message: 'Missing DEEPGRAM_API_KEY' }
  }
  try {
    const resp = await fetch('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (resp.ok) {
      return { status: 'ok', message: 'Deepgram API reachable and authenticated' }
    }
    return {
      status: 'fail',
      message: `Deepgram returned ${resp.status}`,
      details: resp.status === 401 ? 'Invalid API key' : await resp.text().catch(() => ''),
    }
  } catch (err: any) {
    return {
      status: 'fail',
      message: 'Deepgram unreachable',
      details: err.message || String(err),
    }
  }
}

async function checkAvatarReply(baseUrl: string): Promise<CheckResult> {
  try {
    const resp = await fetch(`${baseUrl}/api/avatar-reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'health-check', conversationId: 'health-check' }),
      signal: AbortSignal.timeout(10_000),
    })
    // Any non-500 response means the function loaded successfully
    if (resp.status < 500) {
      return { status: 'ok', message: `Avatar Reply reachable (${resp.status})` }
    }
    const body = await resp.text().catch(() => '')
    return {
      status: 'fail',
      message: `Avatar Reply returned ${resp.status}`,
      details: body.slice(0, 500),
    }
  } catch (err: any) {
    return {
      status: 'fail',
      message: 'Avatar Reply unreachable',
      details: err.message || String(err),
    }
  }
}

async function checkTunnelLatency(): Promise<CheckResult> {
  const url = 'https://opm.onioko.com/health'
  try {
    const start = Date.now()
    const resp = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
    })
    const elapsed = Date.now() - start

    if (!resp.ok) {
      return {
        status: 'fail',
        message: `Tunnel returned ${resp.status}`,
        response_time_ms: elapsed,
      }
    }
    if (elapsed > 5000) {
      return {
        status: 'degraded',
        message: `Tunnel latency high: ${elapsed}ms`,
        response_time_ms: elapsed,
      }
    }
    return {
      status: 'ok',
      message: `Tunnel latency ${elapsed}ms`,
      response_time_ms: elapsed,
    }
  } catch (err: any) {
    return {
      status: 'fail',
      message: 'Tunnel unreachable',
      details: err.message || String(err),
    }
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { client } = getSupabaseAdmin()

  const baseUrl = process.env.VITE_APP_URL || `https://${req.headers.host}`

  // Run all checks in parallel
  const [dbSchema, opm, auth, tts, chatApi, transcription, tunnelLatency, avatarReply] = await Promise.all([
    client
      ? checkDbSchema(client)
      : { status: 'fail' as const, message: 'Supabase not configured — skipping schema check' },
    checkOpm(),
    checkAuth(),
    checkTts(),
    checkChatApi(baseUrl),
    checkTranscription(),
    checkTunnelLatency(),
    checkAvatarReply(baseUrl),
  ])

  const checks = { db_schema: dbSchema, opm, auth, tts, chat_api: chatApi, transcription, tunnel_latency: tunnelLatency, avatar_reply: avatarReply }
  const allOk = Object.values(checks).every((c) => c.status === 'ok' || c.status === 'degraded')

  return res.status(allOk ? 200 : 500).json({
    status: allOk ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    checks,
  })
}
