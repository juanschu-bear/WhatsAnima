import { getSupabaseAdmin, normalizeBody } from './_lib/liveSessionAudit.js'

function buildOrigin(req: any) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').trim()
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').trim()
  const host = forwardedHost || String(req.headers.host || '').trim()
  const protocol = forwardedProto || (host.includes('localhost') ? 'http' : 'https')
  return `${protocol}://${host}`
}

function createMeetingToken() {
  const randomPart = Math.random().toString(36).slice(2, 10)
  return `mtg-${Date.now().toString(36)}-${randomPart}`
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
  const ownerId = String(body.owner_id || body.ownerId || '').trim()
  const topic = String(body.topic || '').trim() || null
  if (!ownerId) {
    return res.status(400).json({ error: 'owner_id is required' })
  }

  const token = createMeetingToken()
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString()
  const { data, error } = await supabase
    .from('wa_meeting_sessions')
    .insert({
      owner_id: ownerId,
      token,
      topic,
      participants: [],
      status: 'waiting',
      expires_at: expiresAt,
    })
    .select('id, owner_id, token, topic, participants, status, created_at, expires_at, recording_url')
    .single()

  if (error) {
    console.error('[meeting-create] insert failed', error)
    return res.status(500).json({ error: error.message || 'Failed to create meeting session' })
  }

  const joinUrl = `${buildOrigin(req)}/meeting/${token}`
  return res.status(200).json({
    ...data,
    join_url: joinUrl,
  })
}
