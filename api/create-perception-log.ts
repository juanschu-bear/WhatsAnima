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

/**
 * Canon 5-Tier Baseline System
 *
 * Each tier recalibrates the entire baseline from ALL collected data.
 * Higher tiers = more data = higher confidence = more reliable deltas.
 *
 * Tier 0: building       (< 60s)       — collecting, no baseline yet
 * Tier 1: snapshot       (≥ 60s)       — first glimpse, ~15% confidence
 * Tier 2: session        (≥ 30min)     — session-level stability, ~40% confidence
 * Tier 3: short_term     (≥ 60min)     — daily pattern emerges, ~60% confidence
 * Tier 4: established    (≥ 180min)    — real personal tendency, ~80% confidence
 * Tier 5: deep           (≥ 600min)    — long-term profile, ~95% confidence
 */
const CANON_TIERS = [
  { tier: 1, name: 'snapshot',    threshold_sec: 60,      confidence: 0.15, label: 'Initial Snapshot' },
  { tier: 2, name: 'session',     threshold_sec: 1800,    confidence: 0.40, label: 'Session Baseline' },
  { tier: 3, name: 'short_term',  threshold_sec: 3600,    confidence: 0.60, label: 'Short-Term Baseline' },
  { tier: 4, name: 'established', threshold_sec: 10800,   confidence: 0.80, label: 'Established Baseline' },
  { tier: 5, name: 'deep',        threshold_sec: 36000,   confidence: 0.95, label: 'Deep Profile' },
] as const

type TierName = typeof CANON_TIERS[number]['name']

/** Extract string label from an emotion value that may be a plain string, a JSON-encoded string, or an OPM v4 object like {label, score}. */
function emotionLabel(val: any): string {
  if (typeof val === 'string') {
    if (val.startsWith('{')) {
      try { return JSON.parse(val).label || val } catch { return val }
    }
    return val
  }
  if (val && typeof val === 'object' && typeof val.label === 'string') return val.label
  return ''
}

const PROSODIC_KEYS = [
  'mean_pitch', 'pitch_range', 'pitch_variability',
  'speaking_rate', 'articulation_rate',
  'pause_count', 'mean_pause_duration', 'pause_ratio',
  'volume_mean', 'volume_range', 'volume_variability',
  'jitter', 'shimmer', 'harmonic_to_noise_ratio',
]

/**
 * Determine which tier the cumulative seconds qualify for.
 * Returns the highest tier reached, or null if below 60s.
 */
function getCurrentTier(cumulativeSec: number) {
  let reached = null
  for (const tier of CANON_TIERS) {
    if (cumulativeSec >= tier.threshold_sec) {
      reached = tier
    }
  }
  return reached
}

/**
 * Get the next tier the user hasn't reached yet.
 */
function getNextTier(cumulativeSec: number) {
  for (const tier of CANON_TIERS) {
    if (cumulativeSec < tier.threshold_sec) {
      return tier
    }
  }
  return null // all tiers completed
}

/**
 * Remove outliers from a numeric array using IQR (Interquartile Range).
 * Returns only values within [Q1 - 1.5*IQR, Q3 + 1.5*IQR].
 * With fewer than 4 samples, no filtering is applied (not enough data).
 */
function removeOutliers(values: number[]): number[] {
  if (values.length < 4) return values
  const sorted = [...values].sort((a, b) => a - b)
  const q1 = sorted[Math.floor(sorted.length * 0.25)]
  const q3 = sorted[Math.floor(sorted.length * 0.75)]
  const iqr = q3 - q1
  const lower = q1 - 1.5 * iqr
  const upper = q3 + 1.5 * iqr
  return values.filter((v) => v >= lower && v <= upper)
}

/**
 * Compute personal baseline from ALL perception logs.
 * Full recalculation every time a new tier is reached.
 * Uses IQR outlier filtering so a single noisy sample can't corrupt the baseline.
 */
function computeBaseline(logs: any[]) {
  const withProsody = logs.filter((l) => l.prosodic_summary)
  if (withProsody.length === 0) return null

  // Collect all values per key, then filter outliers before averaging
  const allValues: Record<string, number[]> = {}

  for (const log of withProsody) {
    const p = log.prosodic_summary
    for (const key of PROSODIC_KEYS) {
      const val = typeof p[key] === 'number' ? p[key] : parseFloat(p[key])
      if (!isNaN(val)) {
        if (!allValues[key]) allValues[key] = []
        allValues[key].push(val)
      }
    }
  }

  const baseline: Record<string, number> = {}
  for (const [key, values] of Object.entries(allValues)) {
    const cleaned = removeOutliers(values)
    if (cleaned.length === 0) continue
    const sum = cleaned.reduce((a, b) => a + b, 0)
    baseline[key] = Math.round((sum / cleaned.length) * 1000) / 1000
  }

  // Emotion distribution — only from logs with real OPM data (prosodic_summary present)
  const emotionCounts: Record<string, number> = {}
  let totalEmotionLogs = 0
  for (const log of withProsody) {
    if (log.primary_emotion) {
      const emotion = emotionLabel(log.primary_emotion).toLowerCase()
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
    sample_count: withProsody.length,
    prosodic_sample_count: withProsody.length,
  }
}

/**
 * Compute delta between current message and personal baseline.
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

  let emotionDelta = null
  if (current.primary_emotion && baseline.emotion_distribution) {
    const emotion = emotionLabel(current.primary_emotion).toLowerCase()
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
    // 1. Insert perception log with ALL data
    const { data: log, error: insertError } = await supabase
      .from('wa_perception_logs')
      .insert({
        message_id: messageId ?? null,
        conversation_id: conversationId,
        contact_id: contactId,
        owner_id: ownerId,
        transcript: transcript ?? null,
        audio_duration_sec: audioDurationSec ?? null,
        primary_emotion: emotionLabel(primaryEmotion) || null,
        secondary_emotion: emotionLabel(secondaryEmotion) || null,
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

    // 2. Canon: get cumulative audio for this contact (across ALL owners)
    //    ONLY count logs with real OPM prosodic data — fallback (prosodic_summary=null) must not inflate Canon.
    const { data: durationData } = await supabase
      .from('wa_perception_logs')
      .select('audio_duration_sec')
      .eq('contact_id', contactId)
      .not('audio_duration_sec', 'is', null)
      .not('prosodic_summary', 'is', null)

    const cumulativeSec = (durationData || []).reduce(
      (sum: number, row: any) => sum + (row.audio_duration_sec || 0),
      0
    )

    // 3. Canon: determine current tier
    const currentTier = getCurrentTier(cumulativeSec)
    const nextTier = getNextTier(cumulativeSec)

    if (!currentTier) {
      // Below 60s — still building, no baseline yet
      const firstTier = CANON_TIERS[0]
      return res.status(200).json({
        log,
        canon: {
          phase: 'building',
          tier: 0,
          tier_name: 'building',
          tier_label: 'Collecting Audio',
          confidence: 0,
          cumulative_sec: Math.round(cumulativeSec * 10) / 10,
          next_tier: {
            name: firstTier.name,
            label: firstTier.label,
            threshold_sec: firstTier.threshold_sec,
            remaining_sec: Math.round((firstTier.threshold_sec - cumulativeSec) * 10) / 10,
            progress: Math.min(Math.round((cumulativeSec / firstTier.threshold_sec) * 100), 99),
          },
          baseline: null,
          delta: null,
        },
      })
    }

    // 4. Canon: check existing baseline (per contact, NOT per owner)
    const { data: existingBaseline } = await supabase
      .from('wa_voice_baseline')
      .select('id, current_tier, baseline_data, cumulative_audio_sec, sample_count')
      .eq('contact_id', contactId)
      .maybeSingle()

    const existingTier = existingBaseline?.current_tier ?? 0
    const tierJustAdvanced = currentTier.tier > existingTier
    let baselineData = existingBaseline?.baseline_data ?? null

    // Update baseline after EVERY perception log with real OPM data, not just on tier advancement.
    // This ensures sample_count stays accurate and the baseline improves continuously.
    const hasRealOpmData = prosodicSummary != null
    const needsUpdate = hasRealOpmData || tierJustAdvanced

    if (needsUpdate) {
      // Recalculate from ALL logs with real OPM data (across all owners for this contact)
      const { data: allLogs } = await supabase
        .from('wa_perception_logs')
        .select('prosodic_summary, primary_emotion, audio_duration_sec')
        .eq('contact_id', contactId)
        .not('prosodic_summary', 'is', null)

      const newBaseline = computeBaseline(allLogs || [])

      if (newBaseline) {
        baselineData = newBaseline
        console.log(`[canon] Baseline update for contact=${contactId}: tier=${currentTier.tier} samples=${newBaseline.sample_count} cumulative_sec=${Math.round(cumulativeSec)} tier_advanced=${tierJustAdvanced} has_opm=${hasRealOpmData}`)

        if (existingBaseline) {
          // Update existing baseline row
          await supabase
            .from('wa_voice_baseline')
            .update({
              current_tier: currentTier.tier,
              tier_name: currentTier.name,
              confidence: currentTier.confidence,
              cumulative_audio_sec: cumulativeSec,
              baseline_data: newBaseline,
              sample_count: newBaseline.sample_count,
              updated_at: new Date().toISOString(),
            })
            .eq('id', existingBaseline.id)
        } else {
          // First baseline ever — insert (no owner_id, baseline is per contact)
          const { error: baselineError } = await supabase
            .from('wa_voice_baseline')
            .insert({
              contact_id: contactId,
              current_tier: currentTier.tier,
              tier_name: currentTier.name,
              confidence: currentTier.confidence,
              cumulative_audio_sec: cumulativeSec,
              baseline_data: newBaseline,
              sample_count: newBaseline.sample_count,
            })

          if (baselineError) {
            console.warn('[canon] Baseline insert error:', baselineError.message)
          }
        }
      } else {
        console.log(`[canon] Baseline update skipped for contact=${contactId}: computeBaseline returned null (no prosodic data in logs)`)
      }
    } else {
      console.log(`[canon] Baseline update skipped for contact=${contactId}: no real OPM data in this message (prosodic_summary is null) and no tier advancement`)
    }

    // 5. Compute delta against baseline (current or just-recalibrated)
    let delta = null
    if (baselineData) {
      delta = computeDelta(
        { prosodic_summary: prosodicSummary, primary_emotion: emotionLabel(primaryEmotion) },
        baselineData
      )
    }

    const phase = tierJustAdvanced
      ? 'tier_advanced'
      : baselineData
        ? 'analyzing_delta'
        : 'building'

    return res.status(200).json({
      log,
      canon: {
        phase,
        tier: currentTier.tier,
        tier_name: currentTier.name,
        tier_label: currentTier.label,
        confidence: currentTier.confidence,
        cumulative_sec: Math.round(cumulativeSec * 10) / 10,
        next_tier: nextTier
          ? {
              name: nextTier.name,
              label: nextTier.label,
              threshold_sec: nextTier.threshold_sec,
              remaining_sec: Math.round((nextTier.threshold_sec - cumulativeSec) * 10) / 10,
              progress: Math.min(Math.round((cumulativeSec / nextTier.threshold_sec) * 100), 99),
            }
          : null,
        baseline: baselineData,
        delta,
      },
    })
  } catch (err: any) {
    console.error('[create-perception-log] Error:', err.message || err)
    return res.status(500).json({ error: err.message || 'Failed to create perception log' })
  }
}
