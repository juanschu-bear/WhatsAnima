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
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Cache for 60s to avoid hammering DB on every page load
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=30')

  const supabase = getSupabaseAdmin()
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase not configured' })
  }

  const sevenDaysAgo = new Date(Date.now() - SEVEN_DAYS_MS).toISOString()

  // Fetch last 7 days of checks (paginated to bypass PostgREST max-rows cap)
  // and incidents in parallel
  const PAGE_SIZE = 1000
  const [firstPage, incidentsResult] = await Promise.all([
    supabase
      .from('wa_health_checks')
      .select('check_name, status, message, response_time_ms, timestamp')
      .gte('timestamp', sevenDaysAgo)
      .order('timestamp', { ascending: false })
      .range(0, PAGE_SIZE - 1),
    supabase
      .from('wa_incidents')
      .select('*')
      .gte('started_at', sevenDaysAgo)
      .order('started_at', { ascending: false }),
  ])

  let checks = firstPage.data || []

  // Keep fetching until we get all rows (server may cap each page)
  if (checks.length === PAGE_SIZE) {
    let offset = PAGE_SIZE
    while (true) {
      const { data } = await supabase
        .from('wa_health_checks')
        .select('check_name, status, message, response_time_ms, timestamp')
        .gte('timestamp', sevenDaysAgo)
        .order('timestamp', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1)
      if (!data || data.length === 0) break
      checks = checks.concat(data)
      if (data.length < PAGE_SIZE) break
      offset += PAGE_SIZE
    }
  }

  const incidents = incidentsResult.data || []

  // Build per-service summary
  const services = CHECK_NAMES.map((name) => {
    const serviceChecks = checks.filter((c: any) => c.check_name === name)
    const total = serviceChecks.length
    const okCount = serviceChecks.filter((c: any) => c.status === 'ok').length
    const uptimePercent = total > 0 ? Math.round((okCount / total) * 10000) / 100 : null
    const latest = serviceChecks.length > 0 ? serviceChecks[0] : null

    return {
      name,
      current_status: latest?.status || 'unknown',
      last_message: latest?.message || null,
      last_check: latest?.timestamp || null,
      uptime_percent: uptimePercent,
      // Timeline: bucket checks into 84 slots (7 days × 12 per day = every 2 hours)
      timeline: buildTimeline(serviceChecks, sevenDaysAgo),
    }
  })

  return res.status(200).json({ services, incidents })
}

function buildTimeline(checks: any[], sinceIso: string) {
  const slots = 84 // 7 days × 12 slots/day (every 2 hours)
  const sinceMs = new Date(sinceIso).getTime()
  const nowMs = Date.now()
  const slotDuration = (nowMs - sinceMs) / slots

  const timeline: ('ok' | 'fail' | 'degraded' | 'no_data')[] = new Array(slots).fill('no_data')

  for (const check of checks) {
    const ts = new Date(check.timestamp).getTime()
    if (isNaN(ts)) continue
    const idx = Math.min(Math.floor((ts - sinceMs) / slotDuration), slots - 1)
    if (idx >= 0) {
      // Priority: fail > degraded > ok > no_data
      if (timeline[idx] === 'no_data') {
        timeline[idx] = check.status === 'ok' ? 'ok' : check.status === 'degraded' ? 'degraded' : 'fail'
      } else if (check.status === 'fail') {
        timeline[idx] = 'fail'
      } else if (check.status === 'degraded' && timeline[idx] === 'ok') {
        timeline[idx] = 'degraded'
      }
    }
  }

  return timeline
}
