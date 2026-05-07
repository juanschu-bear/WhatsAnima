import { normalizeTimezone } from './temporalCore.js'

type PatternRow = {
  user_id: string
  pattern_type: 'time_of_day' | 'weekly' | 'commitment_accuracy' | 'avoidance' | 'emotional_cycle'
  pattern_data: Record<string, unknown>
  detected_at: string
  session_count: number
  active: boolean
}

export async function computeTemporalPatternsForUser(params: {
  supabase: any
  ownerId: string
  userId: string
  timezone?: string
}): Promise<PatternRow[]> {
  const { supabase, ownerId, userId } = params
  const timezone = normalizeTimezone(params.timezone)
  const { data: conversations } = await supabase
    .from('wa_conversations')
    .select('id, updated_at, created_at')
    .eq('owner_id', ownerId)
    .order('updated_at', { ascending: false })
    .limit(120)

  const convIds = (conversations || []).map((c: any) => c.id)
  if (!convIds.length) return []

  const [{ data: messages }, { data: events }] = await Promise.all([
    supabase
      .from('wa_messages')
      .select('conversation_id, sender, created_at, content')
      .in('conversation_id', convIds)
      .order('created_at', { ascending: false })
      .limit(1500),
    supabase
      .from('wa_temporal_events')
      .select('status, event_type, trigger_at, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(500),
  ])

  const allMessages = Array.isArray(messages) ? messages : []
  const userMessages = allMessages.filter((m: any) => m.sender === 'contact')
  const temporalEvents = Array.isArray(events) ? events : []
  const sessionCount = convIds.length
  const now = new Date().toISOString()
  const enoughForTod = userMessages.length >= 20
  const enoughForWeekly = userMessages.length >= 30
  const enoughForCommitment = temporalEvents.length >= 12
  const enoughForAvoidance = userMessages.length >= 25
  const enoughForEmotional = userMessages.length >= 25

  const byHour = new Map<number, number>()
  const byWeekday = new Map<number, number>()
  for (const m of userMessages) {
    const d = new Date(m.created_at)
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hour12: false }).format(d))
    const weekday = Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(d).length)
    byHour.set(hour, (byHour.get(hour) || 0) + 1)
    byWeekday.set(weekday, (byWeekday.get(weekday) || 0) + 1)
  }

  const topHour = [...byHour.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const topWeekdayBucket = [...byWeekday.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  const completed = temporalEvents.filter((e: any) => e.status === 'completed').length
  const overdue = temporalEvents.filter((e: any) => e.status === 'pending' && new Date(e.trigger_at).getTime() < Date.now()).length
  const triggered = temporalEvents.filter((e: any) => e.status === 'triggered').length
  const totalCommitments = temporalEvents.length || 1
  const commitmentAccuracy = Math.max(0, Math.min(1, completed / totalCommitments))

  const avoidanceSignals = userMessages.filter((m: any) => /\blater|später|después|mañana|next week|irgendwann\b/i.test(String(m.content || ''))).length
  const emotionalLexicon = {
    stressed: /\b(stress|overwhelmed|pressure|anxious|gestresst|überfordert|druck|ansiedad|estresad[oa])\b/i,
    motivated: /\b(motivated|excited|energized|klar|bereit|motiviert|emocionad[oa]|con ganas)\b/i,
    relaxed: /\b(calm|relaxed|ruhig|entspannt|tranquilo|relajad[oa])\b/i,
  }
  const emotionCounts = { stressed: 0, motivated: 0, relaxed: 0 }
  for (const m of userMessages) {
    const content = String(m.content || '')
    if (emotionalLexicon.stressed.test(content)) emotionCounts.stressed += 1
    if (emotionalLexicon.motivated.test(content)) emotionCounts.motivated += 1
    if (emotionalLexicon.relaxed.test(content)) emotionCounts.relaxed += 1
  }
  const dominantEmotion = Object.entries(emotionCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral'

  const patterns: PatternRow[] = [
    {
      user_id: userId,
      pattern_type: 'time_of_day',
      pattern_data: {
        timezone,
        top_hour_local: topHour,
        bucket_counts: Object.fromEntries(byHour),
        confidence: enoughForTod ? 0.72 : 0.0,
        min_sample_met: enoughForTod,
      },
      detected_at: now,
      session_count: sessionCount,
      active: enoughForTod,
    },
    {
      user_id: userId,
      pattern_type: 'weekly',
      pattern_data: {
        top_weekday_bucket: topWeekdayBucket,
        bucket_counts: Object.fromEntries(byWeekday),
        confidence: enoughForWeekly ? 0.7 : 0.0,
        min_sample_met: enoughForWeekly,
      },
      detected_at: now,
      session_count: sessionCount,
      active: enoughForWeekly,
    },
    {
      user_id: userId,
      pattern_type: 'commitment_accuracy',
      pattern_data: {
        completed,
        triggered,
        overdue,
        total: temporalEvents.length,
        accuracy: Number(commitmentAccuracy.toFixed(3)),
        confidence: enoughForCommitment ? 0.75 : 0.0,
        min_sample_met: enoughForCommitment,
      },
      detected_at: now,
      session_count: sessionCount,
      active: enoughForCommitment,
    },
    {
      user_id: userId,
      pattern_type: 'avoidance',
      pattern_data: {
        deferral_phrase_count: avoidanceSignals,
        ratio: Number((avoidanceSignals / Math.max(1, userMessages.length)).toFixed(3)),
        confidence: enoughForAvoidance ? 0.66 : 0.0,
        min_sample_met: enoughForAvoidance,
      },
      detected_at: now,
      session_count: sessionCount,
      active: enoughForAvoidance,
    },
    {
      user_id: userId,
      pattern_type: 'emotional_cycle',
      pattern_data: {
        dominant_state: dominantEmotion,
        state_counts: emotionCounts,
        confidence: enoughForEmotional ? 0.62 : 0.0,
        min_sample_met: enoughForEmotional,
      },
      detected_at: now,
      session_count: sessionCount,
      active: enoughForEmotional,
    },
  ]

  return patterns
}

export function buildTemporalEstimationPrompt(patternRows: Array<{ pattern_type: string; pattern_data: any }>): string {
  if (!Array.isArray(patternRows) || patternRows.length === 0) return ''
  const lines = ['[TEMPORAL INTELLIGENCE]']

  const commitment = patternRows.find((p) => p.pattern_type === 'commitment_accuracy')?.pattern_data || {}
  const tod = patternRows.find((p) => p.pattern_type === 'time_of_day')?.pattern_data || {}
  const weekly = patternRows.find((p) => p.pattern_type === 'weekly')?.pattern_data || {}
  const avoidance = patternRows.find((p) => p.pattern_type === 'avoidance')?.pattern_data || {}
  const emotional = patternRows.find((p) => p.pattern_type === 'emotional_cycle')?.pattern_data || {}

  if (tod.top_hour_local !== null && tod.top_hour_local !== undefined) {
    lines.push(`Best engagement time tends to be around ${String(tod.top_hour_local).padStart(2, '0')}:00 local time.`)
  }
  if (weekly.top_weekday_bucket !== null && weekly.top_weekday_bucket !== undefined) {
    lines.push(`Weekly rhythm signal is available, keep recommendations aligned with user's stronger weekdays.`)
  }
  if (typeof commitment.accuracy === 'number') {
    lines.push(`Commitment accuracy trend: ${(commitment.accuracy * 100).toFixed(0)}%. Suggest realistic buffers and proactive check-ins.`)
    const overrunMultiplier = commitment.accuracy > 0 ? Number((1 / Math.max(0.25, commitment.accuracy)).toFixed(2)) : 2
    lines.push(`Planning heuristic: estimated durations should include a buffer multiplier of ~${overrunMultiplier}x.`)
    lines.push('If user sets a deadline, propose one checkpoint before deadline and one at midpoint.')
  }
  if (typeof avoidance.ratio === 'number' && avoidance.ratio > 0.18) {
    lines.push('Avoidance signal is elevated. Gently surface postponed topics and propose specific next steps.')
  }
  if (typeof emotional.dominant_state === 'string' && emotional.dominant_state !== 'neutral') {
    lines.push(`Emotional-cycle hint: recent dominant state appears "${emotional.dominant_state}". Adjust tone accordingly.`)
  }
  lines.push('Never judge the user. Use timing insights to support planning, follow-through, and realistic estimates.')

  return '\n\n' + lines.join('\n')
}
