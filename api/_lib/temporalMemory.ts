import { normalizeTemporalLang, normalizeTimezone } from './temporalCore.js'

export type TemporalCategory =
  | 'future_event'
  | 'deadline'
  | 'recurring'
  | 'past_reference'
  | 'relative_plan'
  | 'duration'
  | 'temporal_preference'
  | 'conversational_plan'
  | 'anniversary'

export type TemporalMemoryHit = {
  text: string
  category: TemporalCategory
  occurred_at?: string | null
  refers_to?: string | null
  urgency?: 'low' | 'medium' | 'high'
}

export type TemporalExtraction = {
  category: TemporalCategory
  mentioned_at: string
  refers_to: string | null
  recurrence_rule: string | null
  reminder_suggested: boolean
  follow_up_after: string | null
  completed: boolean
}

const CATEGORY_PATTERNS: Record<TemporalCategory, RegExp[]> = {
  future_event: [
    /\b(meeting|appointment|termin|cita|call)\b.*\b(at|um|a las)\b/i,
    /\b(tomorrow|morgen|mañana)\b.*\b(at|um|a las)\b/i,
    /\b(next|nächsten?|kommenden?|proximo|próximo)\s+(monday|tuesday|wednesday|thursday|friday|samstag|sonntag|montag|dienstag|mittwoch|donnerstag|viernes|jueves|miercoles|miércoles)\b/i,
    /\b(remind me|erinner mich|recuerdame|recuérdame)\b/i,
  ],
  deadline: [/\b(by|until|bis|deadline|fällig|antes de)\b/i, /\b(submit|abgabe|entregar)\b/i],
  recurring: [/\bevery\b/i, /\bjeden\b/i, /\bcada\b/i, /\bweekly|monthly|daily\b/i],
  past_reference: [/\b(last|ago|yesterday|gestern|hace|anoche)\b/i],
  relative_plan: [
    /\b(in\s+\d+(?:[.,]\d+)?\s*(months?|weeks?|wochen|semanas?|days?|tage|días?|years?|jahre|años?))\b/i,
    /\b(12\s*(to|-)\s*18\s*months?|12\s*bis\s*18\s*monate|12\s*a\s*18\s*meses)\b/i,
  ],
  duration: [/\bfor\s+\d+\s*(minutes?|hours?|days?)\b/i, /\b\d+\s*(stunden|minuten|horas|minutos)\b/i],
  temporal_preference: [/\b(morning person|before 10|quiet hours|nicht vor|no me llames)\b/i],
  conversational_plan: [/\b(let'?s talk|lass uns|hablamos)\b.*\b(later|tonight|morgen|mañana|next week)\b/i],
  anniversary: [/\bbirthday\b/i, /\bgeburtstag\b/i, /\baniversario\b/i],
}

function detectCategory(text: string): TemporalCategory | null {
  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS) as Array<[TemporalCategory, RegExp[]]>) {
    if (patterns.some((rx) => rx.test(text))) return category
  }
  return null
}

function extractClockTime(text: string): { hour: number; minute: number } | null {
  const m = text.match(/\b(\d{1,2})(?::|\.|h)?(\d{2})?\s*(uhr|pm|am)?\b/i)
  if (!m) return null
  let hour = Number(m[1])
  const minute = Number(m[2] || 0)
  const ampm = String(m[3] || '').toLowerCase()
  if (!Number.isFinite(hour) || hour > 24 || minute > 59) return null
  if (ampm === 'pm' && hour < 12) hour += 12
  if (ampm === 'am' && hour === 12) hour = 0
  return { hour, minute }
}

function resolveRefersTo(text: string, timezone: string): string | null {
  const lower = text.toLowerCase()
  const now = new Date()
  const base = new Date(now)

  if (/\btomorrow|morgen|mañana\b/i.test(lower)) base.setDate(base.getDate() + 1)
  if (/\byesterday|gestern|ayer\b/i.test(lower)) base.setDate(base.getDate() - 1)
  if (/\bnext week|nächste woche|proxima semana|próxima semana\b/i.test(lower)) base.setDate(base.getDate() + 7)

  const weekdayMap: Array<[RegExp, number]> = [
    [/\b(monday|montag|lunes)\b/i, 1],
    [/\b(tuesday|dienstag|martes)\b/i, 2],
    [/\b(wednesday|mittwoch|miercoles|miércoles)\b/i, 3],
    [/\b(thursday|donnerstag|jueves)\b/i, 4],
    [/\b(friday|freitag|viernes)\b/i, 5],
    [/\b(saturday|samstag|sábado|sabado)\b/i, 6],
    [/\b(sunday|sonntag|domingo)\b/i, 0],
  ]
  const targetWeekday = weekdayMap.find(([rx]) => rx.test(lower))?.[1]
  const isNextWeekday = /\b(next|nächsten?|kommenden?|proximo|próximo)\b/i.test(lower)
  if (typeof targetWeekday === 'number') {
    const current = base.getDay()
    let delta = (targetWeekday - current + 7) % 7
    if (delta === 0 || isNextWeekday) delta += 7
    base.setDate(base.getDate() + delta)
  }

  const clock = extractClockTime(text)
  if (clock) {
    base.setHours(clock.hour, clock.minute, 0, 0)
  } else if (/\btonight|heute abend|esta noche\b/i.test(lower)) {
    base.setHours(20, 0, 0, 0)
  } else if (/\bmorning|morgen früh|mañana por la mañana\b/i.test(lower)) {
    base.setHours(9, 0, 0, 0)
  } else if (/\bafternoon|nachmittag|tarde\b/i.test(lower)) {
    base.setHours(15, 0, 0, 0)
  }

  if (/in\s+\d+(?:[.,]\d+)?\s*(minutes?|mins?|min|minuten|minutos)/i.test(lower)) {
    const nRaw = (lower.match(/in\s+(\d+(?:[.,]\d+)?)/i) || [])[1] || '0'
    const n = Number(nRaw.replace(',', '.'))
    return new Date(now.getTime() + n * 60_000).toISOString()
  }
  if (/in\s+\d+(?:[.,]\d+)?\s*(hours?|stunden|horas)/i.test(lower)) {
    const nRaw = (lower.match(/in\s+(\d+(?:[.,]\d+)?)/i) || [])[1] || '0'
    const n = Number(nRaw.replace(',', '.'))
    return new Date(now.getTime() + n * 3_600_000).toISOString()
  }
  if (/in\s+\d+(?:[.,]\d+)?\s*(days?|tage|d[ií]as?)/i.test(lower)) {
    const nRaw = (lower.match(/in\s+(\d+(?:[.,]\d+)?)/i) || [])[1] || '0'
    const n = Number(nRaw.replace(',', '.'))
    return new Date(now.getTime() + n * 86_400_000).toISOString()
  }
  if (/in\s+\d+(?:[.,]\d+)?\s*(weeks?|wochen|semanas?)/i.test(lower)) {
    const nRaw = (lower.match(/in\s+(\d+(?:[.,]\d+)?)/i) || [])[1] || '0'
    const n = Number(nRaw.replace(',', '.'))
    return new Date(now.getTime() + n * 7 * 86_400_000).toISOString()
  }
  if (/\b(next week|n[aä]chste woche|proxima semana|pr[oó]xima semana)\b/i.test(lower) && !clock) {
    base.setHours(9, 0, 0, 0)
    return base.toISOString()
  }
  if (/\b(tomorrow morning|morgen fr[uü]h|mañana por la ma[nñ]ana)\b/i.test(lower)) {
    base.setHours(9, 0, 0, 0)
    return base.toISOString()
  }
  if (/\b(tomorrow evening|morgen abend|mañana por la noche|mañana noche)\b/i.test(lower)) {
    base.setHours(20, 0, 0, 0)
    return base.toISOString()
  }

  // Store ISO UTC; timezone retained in metadata.
  return base.toISOString()
}

function recurrenceRuleFor(text: string, category: TemporalCategory): string | null {
  if (category !== 'recurring' && category !== 'anniversary') return null
  const lower = text.toLowerCase()
  if (/every monday|jeden montag|cada lunes/.test(lower)) return 'FREQ=WEEKLY;BYDAY=MO'
  if (/every tuesday|jeden dienstag|cada martes/.test(lower)) return 'FREQ=WEEKLY;BYDAY=TU'
  if (/every wednesday|jeden mittwoch|cada miercoles|cada miércoles/.test(lower)) return 'FREQ=WEEKLY;BYDAY=WE'
  if (/every thursday|jeden donnerstag|cada jueves/.test(lower)) return 'FREQ=WEEKLY;BYDAY=TH'
  if (/every friday|jeden freitag|cada viernes/.test(lower)) return 'FREQ=WEEKLY;BYDAY=FR'
  if (/birthday|geburtstag|cumplea/.test(lower)) return 'FREQ=YEARLY'
  return null
}

export function extractTemporalFacts(input: {
  text: string
  timezone?: string
  lang?: string
}): TemporalExtraction[] {
  const text = String(input.text || '').trim()
  if (!text) return []
  const timezone = normalizeTimezone(input.timezone)
  const _lang = normalizeTemporalLang(input.lang)
  const category = detectCategory(text)
  if (!category) return []
  const mentionedAt = new Date().toISOString()
  const refersTo = resolveRefersTo(text, timezone)
  const recurrenceRule = recurrenceRuleFor(text, category)
  const reminderSuggested =
    ['future_event', 'deadline', 'conversational_plan', 'anniversary', 'relative_plan'].includes(category)
  const followUpAfter =
    category === 'deadline' && refersTo
      ? new Date(new Date(refersTo).getTime() + 60 * 60_000).toISOString()
      : category === 'conversational_plan' && refersTo
        ? refersTo
        : category === 'relative_plan' && refersTo
          ? new Date(new Date(refersTo).getTime() + 24 * 60 * 60_000).toISOString()
        : null
  return [
    {
      category,
      mentioned_at: mentionedAt,
      refers_to: refersTo,
      recurrence_rule: recurrenceRule,
      reminder_suggested: reminderSuggested,
      follow_up_after: followUpAfter,
      completed: false,
    },
  ]
}

async function ingestMomo(
  text: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const endpoint = String(process.env.MOMO_INGEST_URL || process.env.MOMO_URL || 'http://localhost:8889/ingest')
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, metadata }),
      signal: AbortSignal.timeout(12_000),
    })
  } catch (error) {
    console.warn('[temporal-memory] MOMO ingest failed:', error)
  }
}

export async function ingestTemporalMemories(params: {
  text: string
  conversationId: string
  ownerId?: string | null
  avatarName?: string | null
  channel: 'chat' | 'voice_message' | 'video_call'
  timezone?: string
}): Promise<void> {
  const extractions = extractTemporalFacts({
    text: params.text,
    timezone: params.timezone,
  })
  if (!extractions.length) return

  for (const item of extractions) {
    const temporalPayload = {
      text: params.text,
      temporal: item,
      source: params.channel,
      channel: params.channel,
      session_id: params.conversationId,
      avatar: params.avatarName || 'avatar',
      owner_id: params.ownerId || null,
      timezone: normalizeTimezone(params.timezone),
    }
    await ingestMomo(params.text, temporalPayload)
  }
}

export async function queryTemporalMemory(params: {
  conversationId?: string
  ownerId?: string | null
  avatarName?: string | null
  question: string
  timezone?: string
}): Promise<TemporalMemoryHit[]> {
  const endpoint = String(process.env.MOMO_QUERY_URL || process.env.MOMO_URL || 'http://localhost:8889/query')
  const nowIso = new Date().toISOString()
  const enhancedQuestion =
    `${params.question}\n[temporal_query] now=${nowIso} tz=${normalizeTimezone(params.timezone)} owner=${params.ownerId || ''} avatar=${params.avatarName || ''}`

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: enhancedQuestion }),
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) return []
    const payload: any = await response.json().catch(() => ({}))
    const memories = Array.isArray(payload?.memories) ? payload.memories : []
    return memories
      .map((item: any) => {
        const cat = String(item?.temporal?.type || item?.category || '').trim() as TemporalCategory
        if (!cat) return null
        const refersTo = item?.temporal?.refers_to || null
        let urgency: 'low' | 'medium' | 'high' | null = item?.urgency || null
        if (!urgency && refersTo) {
          const deltaMs = new Date(refersTo).getTime() - Date.now()
          if (Number.isFinite(deltaMs)) {
            if (deltaMs <= 6 * 60 * 60_000) urgency = 'high'
            else if (deltaMs <= 24 * 60 * 60_000) urgency = 'medium'
            else urgency = 'low'
          }
        }
        return {
          text: String(item?.text || ''),
          category: cat,
          occurred_at: item?.temporal?.mentioned_at || item?.created_at || null,
          refers_to: refersTo,
          urgency: urgency || undefined,
        } as TemporalMemoryHit
      })
      .filter(Boolean) as TemporalMemoryHit[]
  } catch (error) {
    console.warn('[temporal-memory] MOMO query failed:', error)
    return []
  }
}

export async function upsertTemporalEvents(params: {
  supabase: any
  userId: string
  avatarName: string
  memoryId?: number | null
  temporalItems: TemporalExtraction[]
  preferredChannel?: 'chat' | 'call' | 'push'
}): Promise<void> {
  if (!params.supabase || !params.temporalItems.length) return
  const now = Date.now()
  const rows = params.temporalItems
    .filter((item) => Boolean(item.refers_to))
    .map((item) => {
      const triggerAt = new Date(item.refers_to as string)
      const eventType =
        item.category === 'deadline'
          ? 'deadline'
          : item.category === 'conversational_plan'
            ? 'conversation_continue'
            : item.category === 'future_event'
              ? 'reminder'
              : item.category === 'relative_plan'
                ? 'follow_up'
                : 'reminder'

      return {
        user_id: params.userId,
        avatar_name: params.avatarName,
        memory_id: params.memoryId || null,
        event_type: eventType,
        trigger_at: triggerAt.toISOString(),
        action: {
          channel: params.preferredChannel || 'chat',
          category: item.category,
          lead_minutes: 30,
        },
        status: 'pending',
        created_at: new Date(now).toISOString(),
      }
    })
  if (!rows.length) return
  await params.supabase.from('wa_temporal_events').insert(rows)
}
