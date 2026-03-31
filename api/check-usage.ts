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

type FeatureType = 'voice' | 'video' | 'call'

interface UsageRow {
  id: string
  user_id: string
  call_minutes_used: number
  call_minutes_limit: number
  voice_count_used: number
  voice_count_limit: number
  video_count_used: number
  video_count_limit: number
  reset_at: string
}

async function getOrCreateUsage(supabase: ReturnType<typeof createClient>, userId: string): Promise<UsageRow> {
  // Check if reset is needed
  const { data: existing } = await supabase
    .from('wa_usage_limits')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (existing) {
    const row = existing as UsageRow
    // Auto-reset if past reset date
    if (new Date(row.reset_at).getTime() < Date.now()) {
      const { data: reset } = await supabase
        .from('wa_usage_limits')
        .update({
          call_minutes_used: 0,
          voice_count_used: 0,
          video_count_used: 0,
          reset_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)
        .select()
        .single()
      return (reset ?? row) as UsageRow
    }
    return row
  }

  // Create default limits
  const { data: created, error } = await supabase
    .from('wa_usage_limits')
    .insert({
      user_id: userId,
      call_minutes_used: 0,
      call_minutes_limit: 60,
      voice_count_used: 0,
      voice_count_limit: 200,
      video_count_used: 0,
      video_count_limit: 100,
      reset_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select()
    .single()

  if (error) {
    // Race condition: another request created it
    const { data: retry } = await supabase
      .from('wa_usage_limits')
      .select('*')
      .eq('user_id', userId)
      .single()
    return retry as UsageRow
  }

  return created as UsageRow
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

  const { userId, feature, callMinutes } = req.body ?? {}

  if (!userId || !feature) {
    return res.status(400).json({ error: 'userId and feature are required' })
  }

  const featureType = feature as FeatureType
  if (!['voice', 'video', 'call'].includes(featureType)) {
    return res.status(400).json({ error: 'feature must be voice, video, or call' })
  }

  const usage = await getOrCreateUsage(supabase, userId)

  // Check limits
  if (featureType === 'voice') {
    if (usage.voice_count_used >= usage.voice_count_limit) {
      return res.status(429).json({
        error: 'Voice message limit reached',
        used: usage.voice_count_used,
        limit: usage.voice_count_limit,
        reset_at: usage.reset_at,
      })
    }
    // Increment
    await supabase
      .from('wa_usage_limits')
      .update({
        voice_count_used: usage.voice_count_used + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', usage.id)

    return res.status(200).json({
      allowed: true,
      used: usage.voice_count_used + 1,
      limit: usage.voice_count_limit,
      remaining: usage.voice_count_limit - usage.voice_count_used - 1,
    })
  }

  if (featureType === 'video') {
    if (usage.video_count_used >= usage.video_count_limit) {
      return res.status(429).json({
        error: 'Video message limit reached',
        used: usage.video_count_used,
        limit: usage.video_count_limit,
        reset_at: usage.reset_at,
      })
    }
    await supabase
      .from('wa_usage_limits')
      .update({
        video_count_used: usage.video_count_used + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', usage.id)

    return res.status(200).json({
      allowed: true,
      used: usage.video_count_used + 1,
      limit: usage.video_count_limit,
      remaining: usage.video_count_limit - usage.video_count_used - 1,
    })
  }

  // call
  const minutes = typeof callMinutes === 'number' ? callMinutes : 2
  if (usage.call_minutes_used >= usage.call_minutes_limit) {
    return res.status(429).json({
      error: 'Live call minutes limit reached',
      used: Math.round(usage.call_minutes_used * 10) / 10,
      limit: usage.call_minutes_limit,
      reset_at: usage.reset_at,
    })
  }
  // Don't increment yet for calls — just check. Calls increment via heartbeat.
  return res.status(200).json({
    allowed: true,
    used: Math.round(usage.call_minutes_used * 10) / 10,
    limit: usage.call_minutes_limit,
    remaining: Math.round((usage.call_minutes_limit - usage.call_minutes_used) * 10) / 10,
  })
}
