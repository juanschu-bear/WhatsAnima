import { getSupabaseAdmin, normalizeBody } from './_lib/liveSessionAudit.js'

function buildOrigin(req: any) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
  const host = forwardedHost || String(req.headers.host || '').trim()
  const proto = forwardedProto || (host.includes('localhost') ? 'http' : 'https')
  return host ? `${proto}://${host}` : 'https://www.whatsanima.com'
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { client: supabase, missing } = getSupabaseAdmin()
  if (!supabase) {
    return res.status(503).json({ error: `DB not configured – missing ${missing}` })
  }

  try {
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

    const { data: insertedCall, error } = await supabase
      .from('wa_outbound_calls')
      .insert(insertPayload)
      .select('*')
      .single()

    if (error) {
      console.error('[outbound-call-request] insert failed', error)
      return res.status(500).json({ error: error.message || 'Failed to create outbound call' })
    }

    let call = insertedCall

    // Server-side prewarm for immediate calls to reduce answer->connect latency.
    if (immediate) {
      try {
        const prewarmResponse = await fetch(`${buildOrigin(req)}/api/video-call`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            persona_name: callerDisplayName,
            persona: callerDisplayName,
            language: 'en',
            conversation_id: conversationId,
            owner_id: ownerId,
            contact_id: contactId,
            incoming_call_id: call.id,
          }),
        })

        if (prewarmResponse.ok) {
          const prewarmPayload = await prewarmResponse.json().catch(() => ({}))
          if (prewarmPayload?.session_id && prewarmPayload?.join_url) {
            const nextMetadata = {
              ...(call?.metadata && typeof call.metadata === 'object' ? call.metadata : {}),
              prewarmed_session: {
                session_id: String(prewarmPayload.session_id),
                join_url: String(prewarmPayload.join_url),
                warmed_at: new Date().toISOString(),
              },
            }
            const { data: updatedCall } = await supabase
              .from('wa_outbound_calls')
              .update({ metadata: nextMetadata })
              .eq('id', call.id)
              .select('*')
              .single()
            if (updatedCall) call = updatedCall
          }
        }
      } catch (prewarmError) {
        console.warn('[outbound-call-request] prewarm failed', prewarmError)
      }
    }

    return res.status(200).json({ call })
  } catch (error: any) {
    console.error('[outbound-call-request] unexpected error', error)
    return res.status(500).json({ error: 'Failed to create outbound call' })
  }
}
