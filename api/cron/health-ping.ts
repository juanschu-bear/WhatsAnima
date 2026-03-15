import { createClient } from '@supabase/supabase-js'

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

const CHECK_NAMES = ['db_schema', 'opm', 'auth', 'tts', 'chat_api', 'transcription', 'tunnel_latency'] as const

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Verify CRON_SECRET when configured (Vercel Cron sends this automatically)
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const auth = req.headers['authorization']
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  const supabase = getSupabaseAdmin()
  if (!supabase) {
    return res.status(200).json({ ok: false, error: 'Supabase not configured', skipped: true })
  }

  try {
    // Call the existing health-check endpoint using the production URL
    const baseUrl =
      process.env.VITE_APP_URL || 'https://whats-anima.vercel.app'

    let checks: Record<string, { status: string; message?: string }>
    const timings: Record<string, number> = {}

    try {
      const overallStart = Date.now()

      const resp = await fetch(`${baseUrl}/api/health-check`, {
        method: 'GET',
        signal: AbortSignal.timeout(25_000),
      })

      const elapsed = Date.now() - overallStart
      const body = await resp.json()
      checks = body.checks || {}

      // Approximate per-check timing (we only have total; distribute evenly as fallback)
      const perCheck = Math.round(elapsed / CHECK_NAMES.length)
      for (const name of CHECK_NAMES) {
        timings[name] = perCheck
      }
    } catch (err: any) {
      // Health-check endpoint itself is down — mark everything as fail
      checks = {}
      for (const name of CHECK_NAMES) {
        checks[name] = { status: 'fail', message: 'Health-check endpoint unreachable: ' + (err.message || String(err)) }
        timings[name] = 0
      }
    }

    const now = new Date().toISOString()

    // Insert check results
    const rows = CHECK_NAMES.map((name) => ({
      timestamp: now,
      check_name: name,
      status: checks[name]?.status || 'fail',
      message: checks[name]?.message || null,
      response_time_ms: timings[name] || 0,
    }))

    const { error: insertErr } = await supabase.from('wa_health_checks').insert(rows)
    if (insertErr) {
      console.error('Failed to insert health checks:', insertErr.message)
    }

    // --- Incident detection: compare with previous status ---
    for (const name of CHECK_NAMES) {
      const currentStatus = checks[name]?.status || 'fail'

      // Get the most recent previous check for this service (before this run)
      const { data: prev } = await supabase
        .from('wa_health_checks')
        .select('status')
        .eq('check_name', name)
        .lt('timestamp', now)
        .order('timestamp', { ascending: false })
        .limit(1)
        .maybeSingle()

      const prevStatus = prev?.status || 'ok' // assume ok if no history

      if (prevStatus === 'ok' && currentStatus === 'fail') {
        // Open new incident
        await supabase.from('wa_incidents').insert({
          check_name: name,
          started_at: now,
          message: checks[name]?.message || `${name} is down`,
        })
      } else if (prevStatus === 'fail' && currentStatus === 'ok') {
        // Resolve open incident
        const { data: openIncident } = await supabase
          .from('wa_incidents')
          .select('id, started_at, message')
          .eq('check_name', name)
          .is('resolved_at', null)
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (openIncident) {
          const durationMs = new Date(now).getTime() - new Date(openIncident.started_at).getTime()
          const durationMins = Math.floor(durationMs / 60_000)
          const durationStr = durationMins < 60
            ? `${durationMins}m`
            : `${Math.floor(durationMins / 60)}h ${durationMins % 60}m`

          const summary = `${openIncident.message || name + ' was down'}. Duration: ${durationStr}. Resolved automatically when the service recovered.`

          await supabase
            .from('wa_incidents')
            .update({ resolved_at: now, resolution_summary: summary })
            .eq('id', openIncident.id)
        }
      }
    }

    // --- Cleanup: delete checks older than 8 days ---
    const cutoff = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    await supabase.from('wa_health_checks').delete().lt('timestamp', cutoff)

    if (req.method === 'HEAD') return res.status(200).end()
    return res.status(200).json({ ok: true, timestamp: now, checks: rows.length })
  } catch (err: any) {
    console.error('Health ping failed:', err)
    if (req.method === 'HEAD') return res.status(200).end()
    return res.status(200).json({ ok: false, error: err.message || String(err) })
  }
}
