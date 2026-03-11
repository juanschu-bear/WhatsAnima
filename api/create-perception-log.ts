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

const BASELINE_THRESHOLD_SEC = 60

/**
 * Compute personal baseline from all perception logs collected so far.
 * Returns averaged prosodic features as the "personal center".
 */
function computeBaseline(logs: any[]) {
  const withProsody = logs.filter((l) => l.prosodic_summary)
  if (withProsody.length === 0) return null

  const sums: Record<string, number> = {}
  const counts: Record<string, number> = {}
  const prosodicKeys = [
    'mean_pitch', 'pitch_range', 'pitch_variability',
    'speaking_rate', 'articulation_rate',
    'pause_count', 'mean_pause_duration', 'pause_ratio',
    'volume_mean', 'volume_range', 'volume_variability',
    'jitter', 'shimmer', 'harmonic_to_noise_ratio',
  ]

  for (const log of withProsody) {
    const p = log.prosodic_summary
    for (const key of prosodicKeys) {
      const val = typeof p[key] === 'number' ? p[key] : parseFloat(p[key])
      if (!isNaN(val)) {
        sums[key] = (sums[key] || 0) + val
        counts[key] = (counts[key] || 0) + 1
      }
    }
  }

  const baseline: Record<string, number> = {}
  for (const key of Object.keys(sums)) {
    baseline[key] = Math.round((sums[key] / counts[key]) * 1000) / 1000
  }

  // Collect emotion distribution
  const emotionCounts: Record<string, number> = {}
  let totalEmotionLogs = 0
  for (const log of logs) {
    if (log.primary_emotion) {
      const emotion = log.primary_emotion.toLowerCase()
      emotionCounts[emotion] = (emotionCounts[emotion] || 0) + 1
      totalEmotionLogs++
    }
  }
  const emotionDistribution: Record<string, number> = {}
  for (const [emotion, count] of Object.entries(emotionCounts)) {
    emotionDistribution[emotion] = Math.round((count / totalEmotionLogs) * 100) / 100
  }

  return {
    prosodic_center: baseline,
    emotion_distribution: emotionDistribution,
    sample_count: logs.length,
    prosodic_sample_count: withProsody.length,
  }
}

/**
 * Compute delta between current message features and personal baseline.
 */
function computeDelta(current: any, baseline: any) {
  if (!current || !baseline?.prosodic_center) return null

  const delta: Record<string, number> = {}
  const prosody = current.prosodic_summary || {}

  for (const [key, baseVal] of Object.entries(baseline.prosodic_center)) {
    const curVal = typeof prosody[key] === 'number' ? prosody[key] : parseFloat(prosody[key])
    if (!isNaN(curVal) && typeof baseVal === 'number' && baseVal !== 0) {
      delta[key] = Math.round(((curVal - baseVal) / Math.abs(baseVal)) * 1000) / 1000
    }
  }

  // Emotion delta: is current emotion common or unusual for this person?
  let emotionDelta = null
  if (current.primary_emotion && baseline.emotion_distribution) {
    const emotion = current.primary_emotion.toLowerCase()
    const frequency = baseline.emotion_distribution[emotion] || 0
    emotionDelta = {
      emotion,
      personal_frequency: frequency,
      is_unusual: frequency < 0.15,
      is_typical: frequency > 0.3,
    }
  }

  return { prosodic_delta: delta, emotion_delta: emotionDelta }
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

  const {
    messageId,
    conversationId,
    contactId,
    ownerId,
    transcript,
    audioDurationSec,
    // OPM fields
    primaryEmotion,
    secondaryEmotion,
    firedRules,
    behavioralSummary,
    conversationHooks,
    prosodicSummary,
    mediaType,
  } = req.body ?? {}

  if (!conversationId || !contactId || !ownerId) {
    return res.status(400).json({ error: 'conversationId, contactId, and ownerId are required' })
  }

  try {
    // 1. Insert the perception log with ALL data (OPM + message reference)
    const { data: log, error: insertError } = await supabase
      .from('wa_perception_logs')
      .insert({
        message_id: messageId ?? null,
        conversation_id: conversationId,
        contact_id: contactId,
        owner_id: ownerId,
        transcript: transcript ?? null,
        audio_duration_sec: audioDurationSec ?? null,
        primary_emotion: primaryEmotion ?? null,
        secondary_emotion: secondaryEmotion ?? null,
        fired_rules: firedRules ?? [],
        behavioral_summary: behavioralSummary ?? null,
        conversation_hooks: conversationHooks ?? [],
        prosodic_summary: prosodicSummary ?? null,
      })
      .select()
      .single()

    if (insertError) {
      console.error('[create-perception-log] Insert error:', insertError.message)
      return res.status(500).json({ error: insertError.message })
    }

    // 2. Canon: check cumulative audio duration for this contact+owner pair
    const { data: durationData } = await supabase
      .from('wa_perception_logs')
      .select('audio_duration_sec')
      .eq('contact_id', contactId)
      .eq('owner_id', ownerId)
      .not('audio_duration_sec', 'is', null)

    const cumulativeSec = (durationData || []).reduce(
      (sum: number, row: any) => sum + (row.audio_duration_sec || 0),
      0
    )

    // 3. Canon: check if baseline already exists
    const { data: existingBaseline } = await supabase
      .from('wa_voice_baseline')
      .select('id, locked_at, baseline_data')
      .eq('contact_id', contactId)
      .eq('owner_id', ownerId)
      .maybeSingle()

    let canonPhase: 'building' | 'baseline_locked' | 'analyzing_delta' = 'building'
    let baselineData = existingBaseline?.baseline_data ?? null
    let delta = null

    if (existingBaseline) {
      // Baseline exists — compute delta against it
      canonPhase = 'analyzing_delta'
      delta = computeDelta(
        { prosodic_summary: prosodicSummary, primary_emotion: primaryEmotion },
        baselineData
      )
    } else if (cumulativeSec >= BASELINE_THRESHOLD_SEC) {
      // Threshold reached — lock baseline now
      const { data: allLogs } = await supabase
        .from('wa_perception_logs')
        .select('prosodic_summary, primary_emotion, audio_duration_sec')
        .eq('contact_id', contactId)
        .eq('owner_id', ownerId)

      baselineData = computeBaseline(allLogs || [])

      if (baselineData) {
        const { error: baselineError } = await supabase
          .from('wa_voice_baseline')
          .insert({
            contact_id: contactId,
            owner_id: ownerId,
            cumulative_audio_sec: cumulativeSec,
            baseline_data: baselineData,
            sample_count: baselineData.sample_count,
          })

        if (baselineError) {
          console.warn('[canon] Baseline insert error:', baselineError.message)
        } else {
          canonPhase = 'baseline_locked'
          // Compute delta for THIS message against the just-locked baseline
          delta = computeDelta(
            { prosodic_summary: prosodicSummary, primary_emotion: primaryEmotion },
            baselineData
          )
        }
      }
    }

    return res.status(200).json({
      log,
      canon: {
        phase: canonPhase,
        cumulative_sec: Math.round(cumulativeSec * 10) / 10,
        threshold_sec: BASELINE_THRESHOLD_SEC,
        progress: canonPhase === 'building'
          ? Math.min(Math.round((cumulativeSec / BASELINE_THRESHOLD_SEC) * 100), 99)
          : 100,
        baseline: baselineData,
        delta,
      },
    })
  } catch (err: any) {
    console.error('[create-perception-log] Error:', err.message || err)
    return res.status(500).json({ error: err.message || 'Failed to create perception log' })
  }
}
