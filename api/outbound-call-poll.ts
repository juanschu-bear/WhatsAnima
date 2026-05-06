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

  try {
    const { error: expireError } = await supabase
      .from('wa_outbound_calls')
      .update({ status: 'expired', last_error: 'Call invite expired.' })
      .eq('contact_email', contactEmail)
      .eq('status', 'ringing')
      .lt('expires_at', nowIso)
    if (expireError) {
      console.error('[outbound-call-poll] expire failed', expireError)
    }

    const { data: dueCalls, error: dueError } = await supabase
      .from('wa_outbound_calls')
      .select('id')
      .eq('contact_email', contactEmail)
      .eq('status', 'scheduled')
      .lte('scheduled_for', nowIso)
      .order('scheduled_for', { ascending: true })
      .limit(5)

    if (dueError) {
      console.error('[outbound-call-poll] due select failed', dueError)
    } else if (dueCalls && dueCalls.length > 0) {
      const ids = dueCalls.map((row) => row.id)
      const { error: promoteError } = await supabase
        .from('wa_outbound_calls')
        .update({
          status: 'ringing',
          triggered_at: nowIso,
          expires_at: new Date(Date.now() + 2 * 60_000).toISOString(),
        })
        .in('id', ids)
      if (promoteError) {
        console.error('[outbound-call-poll] promote failed', promoteError)
      }
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
      // Never hard-fail this endpoint. The UI polls continuously; 500 would create an endless error loop.
      console.error('[outbound-call-poll] select failed', error)
      return res.status(200).json({ call: null, degraded: true })
    }

    return res.status(200).json({ call: data || null })
  } catch (error: any) {
    console.error('[outbound-call-poll] unexpected error', error)
    return res.status(200).json({ call: null, degraded: true })
  }
}
