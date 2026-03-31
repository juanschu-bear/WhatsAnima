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

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { client: supabase, missing } = getSupabaseAdmin()
  if (!supabase) {
    return res.status(503).json({ error: `DB not configured – missing ${missing}` })
  }

  const { userId, minutes } = req.body ?? {}
  if (!userId || typeof minutes !== 'number') {
    return res.status(400).json({ error: 'userId and minutes (number) are required' })
  }

  const { data: usage } = await supabase
    .from('wa_usage_limits')
    .select('id, call_minutes_used, call_minutes_limit, reset_at')
    .eq('user_id', userId)
    .maybeSingle()

  if (!usage) {
    return res.status(404).json({ error: 'No usage record found' })
  }

  // Auto-reset if past reset date
  const row = usage as { id: string; call_minutes_used: number; call_minutes_limit: number; reset_at: string }
  let currentUsed = row.call_minutes_used
  if (new Date(row.reset_at).getTime() < Date.now()) {
    currentUsed = 0
    await supabase
      .from('wa_usage_limits')
      .update({
        call_minutes_used: 0,
        voice_count_used: 0,
        video_count_used: 0,
        reset_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id)
  }

  const newUsed = currentUsed + minutes
  const limitReached = newUsed >= row.call_minutes_limit

  await supabase
    .from('wa_usage_limits')
    .update({
      call_minutes_used: newUsed,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id)

  return res.status(200).json({
    used: Math.round(newUsed * 10) / 10,
    limit: row.call_minutes_limit,
    remaining: Math.max(0, Math.round((row.call_minutes_limit - newUsed) * 10) / 10),
    limit_reached: limitReached,
  })
}
