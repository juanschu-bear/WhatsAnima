import { getSupabaseAdmin } from './_lib/liveSessionAudit.js'

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { client: supabase, missing } = getSupabaseAdmin()
  if (!supabase) {
    return res.status(503).json({ error: `DB not configured – missing ${missing}` })
  }

  const contactEmail = String(req.query?.email || '').trim().toLowerCase()
  if (!contactEmail) {
    return res.status(400).json({ error: 'email is required' })
  }

  const nowIso = new Date().toISOString()

  await supabase
    .from('wa_outbound_calls')
    .update({ status: 'expired', last_error: 'Call invite expired.' })
    .eq('contact_email', contactEmail)
    .eq('status', 'ringing')
    .lt('expires_at', nowIso)

  const { data: dueCalls } = await supabase
    .from('wa_outbound_calls')
    .select('id')
    .eq('contact_email', contactEmail)
    .eq('status', 'scheduled')
    .lte('scheduled_for', nowIso)
    .order('scheduled_for', { ascending: true })
    .limit(5)

  if (dueCalls && dueCalls.length > 0) {
    const ids = dueCalls.map((row) => row.id)
    await supabase
      .from('wa_outbound_calls')
      .update({
        status: 'ringing',
        triggered_at: nowIso,
        expires_at: new Date(Date.now() + 2 * 60_000).toISOString(),
      })
      .in('id', ids)
  }

  const { data, error } = await supabase
    .from('wa_outbound_calls')
    .select('*')
    .eq('contact_email', contactEmail)
    .eq('status', 'ringing')
    .order('triggered_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[outbound-call-poll] select failed', error)
    return res.status(500).json({ error: error.message || 'Failed to poll outbound calls' })
  }

  return res.status(200).json({ call: data || null })
}
