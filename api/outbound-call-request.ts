import { getSupabaseAdmin, normalizeBody } from './_lib/liveSessionAudit'

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
  const conversationId = String(body.conversationId || '').trim()
  const ownerId = String(body.ownerId || '').trim() || null
  const contactId = String(body.contactId || '').trim() || null
  const contactEmail = String(body.contactEmail || '').trim().toLowerCase()
  const requestedByMessageId = String(body.requestedByMessageId || '').trim() || null
  const triggerText = String(body.triggerText || '').trim()
  const callerDisplayName = String(body.callerDisplayName || '').trim() || 'Avatar'
  const delayMinutesRaw = Number(body.delayMinutes ?? 0)
  const delayMinutes = Number.isFinite(delayMinutesRaw) ? Math.max(0, Math.min(720, Math.round(delayMinutesRaw))) : 0
  const scheduledFor = new Date(Date.now() + delayMinutes * 60_000)
  const immediate = delayMinutes <= 0
  const nowIso = new Date().toISOString()
  const expiresAt = immediate ? new Date(Date.now() + 2 * 60_000).toISOString() : null

  if (!conversationId || !contactEmail || !triggerText) {
    return res.status(400).json({ error: 'conversationId, contactEmail, and triggerText are required' })
  }

  const insertPayload = {
    conversation_id: conversationId,
    owner_id: ownerId,
    contact_id: contactId,
    contact_email: contactEmail,
    requested_by_message_id: requestedByMessageId,
    trigger_text: triggerText,
    mode: 'video',
    status: immediate ? 'ringing' : 'scheduled',
    caller_display_name: callerDisplayName,
    scheduled_for: scheduledFor.toISOString(),
    triggered_at: immediate ? nowIso : null,
    expires_at: expiresAt,
  }

  const { data, error } = await supabase
    .from('wa_outbound_calls')
    .insert(insertPayload)
    .select('*')
    .single()

  if (error) {
    console.error('[outbound-call-request] insert failed', error)
    return res.status(500).json({ error: error.message || 'Failed to create outbound call' })
  }

  return res.status(200).json({ call: data })
}
