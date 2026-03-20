import { getSupabaseAdmin, normalizeBody } from './_lib/liveSessionAudit.js'

type MeetingParticipant = {
  name: string
  role: string
  joined_at: string
}

function normalizeParticipant(raw: any): MeetingParticipant | null {
  const name = String(raw?.name || '').trim()
  const role = String(raw?.role || '').trim()
  if (!name) return null
  return {
    name,
    role: role || 'Participant',
    joined_at: String(raw?.joined_at || new Date().toISOString()),
  }
}

function sameParticipant(a: MeetingParticipant, b: MeetingParticipant) {
  return a.name.toLowerCase() === b.name.toLowerCase() && a.role.toLowerCase() === b.role.toLowerCase()
}

export default async function handler(req: any, res: any) {
  const { client: supabase, missing } = getSupabaseAdmin()
  if (!supabase) {
    return res.status(500).json({ error: `Supabase admin unavailable (${missing || 'unknown'})` })
  }

  if (req.method === 'GET') {
    const token = String(req.query?.token || '').trim()
    if (!token) return res.status(400).json({ error: 'token is required' })

    const { data, error } = await supabase
      .from('wa_meeting_sessions')
      .select('id, owner_id, token, topic, participants, status, created_at, expires_at')
      .eq('token', token)
      .maybeSingle()
    if (error) return res.status(500).json({ error: error.message || 'Failed to load meeting' })
    if (!data) return res.status(404).json({ error: 'Meeting not found' })
    if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ error: 'Meeting has expired' })
    }

    const { data: owner } = await supabase
      .from('wa_owners')
      .select('id, display_name, tavus_replica_id')
      .eq('id', data.owner_id)
      .is('deleted_at', null)
      .maybeSingle()

    return res.status(200).json({
      ...data,
      participants: Array.isArray(data.participants) ? data.participants : [],
      owner: owner || null,
      meeting_context: {
        token: data.token,
        topic: data.topic || '',
        participants: Array.isArray(data.participants) ? data.participants : [],
        owner: owner || null,
      },
    })
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const body = normalizeBody(req)
  const token = String(body.token || '').trim()
  const name = String(body.name || '').trim()
  const role = String(body.role || '').trim()

  if (!token || !name) {
    return res.status(400).json({ error: 'token and name are required' })
  }

  const { data: session, error: sessionError } = await supabase
    .from('wa_meeting_sessions')
    .select('id, owner_id, token, topic, participants, status, created_at, expires_at')
    .eq('token', token)
    .maybeSingle()

  if (sessionError) {
    return res.status(500).json({ error: sessionError.message || 'Failed to load meeting session' })
  }
  if (!session) {
    return res.status(404).json({ error: 'Meeting not found' })
  }
  if (session.expires_at && new Date(session.expires_at).getTime() < Date.now()) {
    return res.status(410).json({ error: 'Meeting has expired' })
  }

  const existingParticipants = Array.isArray(session.participants)
    ? session.participants.map((item: any) => normalizeParticipant(item)).filter(Boolean) as MeetingParticipant[]
    : []
  const candidate = normalizeParticipant({ name, role, joined_at: new Date().toISOString() })
  if (!candidate) {
    return res.status(400).json({ error: 'Invalid participant payload' })
  }
  const mergedParticipants = existingParticipants.some((participant) => sameParticipant(participant, candidate))
    ? existingParticipants
    : [...existingParticipants, candidate]

  const nextStatus = mergedParticipants.length > 0 ? 'ready' : session.status || 'waiting'
  const { data: updated, error: updateError } = await supabase
    .from('wa_meeting_sessions')
    .update({
      participants: mergedParticipants,
      status: nextStatus,
    })
    .eq('id', session.id)
    .select('id, owner_id, token, topic, participants, status, created_at, expires_at')
    .single()

  if (updateError) {
    return res.status(500).json({ error: updateError.message || 'Failed to join meeting session' })
  }

  const { data: owner } = await supabase
    .from('wa_owners')
    .select('id, display_name, tavus_replica_id')
    .eq('id', updated.owner_id)
    .is('deleted_at', null)
    .maybeSingle()

  return res.status(200).json({
    ...updated,
    participant: candidate,
    meeting_context: {
      token: updated.token,
      topic: updated.topic || '',
      participants: Array.isArray(updated.participants) ? updated.participants : [],
      owner: owner || null,
    },
  })
}
