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

  const body = normalizeBody(req)
  const callId = String(body.callId || '').trim()
  const action = String(body.action || '').trim().toLowerCase()
  if (!callId || !['accept', 'decline'].includes(action)) {
    return res.status(400).json({ error: 'callId and valid action are required' })
  }

  const nowIso = new Date().toISOString()
  const patch =
    action === 'accept'
      ? { status: 'accepted', accepted_at: nowIso }
      : { status: 'declined', declined_at: nowIso }

  const { data, error } = await supabase
    .from('wa_outbound_calls')
    .update(patch)
    .eq('id', callId)
    .select('*')
    .single()

  if (error) {
    console.error('[outbound-call-respond] update failed', error)
    return res.status(500).json({ error: error.message || 'Failed to update outbound call' })
  }

  const joinUrl = `${buildOrigin(req)}/video-call/${data.conversation_id}?incomingCallId=${encodeURIComponent(data.id)}`
  return res.status(200).json({ call: data, joinUrl })
}
