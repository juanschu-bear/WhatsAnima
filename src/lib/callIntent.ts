import grammarRaw from './call_intent_grammar.json?raw'

export interface OutboundCallIntent {
  delayMinutes: number
  mode: 'video'
}

type SupportedLang = 'de' | 'en' | 'es'

interface LanguageRules {
  call_verbs: string[]
  call_nouns: string[]
  me_pronouns: string[]
  now_indicators: string[]
  delay_indicators: string[]
  time_units: Record<string, number>
  number_words: Record<string, number>
  avatar_suggest_triggers: string[]
}

interface GrammarFile {
  detection_rules: {
    minimum_confidence: number
    priority_order: string[]
  }
  languages: Record<SupportedLang, LanguageRules>
  response_templates: Record<
    SupportedLang,
    {
      call_now_confirm: string
      call_delayed_confirm: string
      call_suggest: string
      call_failed: string
    }
  >
}

const grammar = JSON.parse(grammarRaw) as GrammarFile
const MAX_DELAY_SECONDS = 24 * 60 * 60
const MAX_DELAY_MINUTES = 720

function normalizeText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function containsTerm(textNormalized: string, term: string): boolean {
  const normalizedTerm = normalizeText(term).trim()
  if (!normalizedTerm) return false
  if (normalizedTerm.includes(' ')) return textNormalized.includes(normalizedTerm)
  const regex = new RegExp(`(^|\\W)${escapeRegex(normalizedTerm)}(\\W|$)`, 'i')
  return regex.test(textNormalized)
}

function containsAny(textNormalized: string, terms: string[]): boolean {
  return terms.some((term) => containsTerm(textNormalized, term))
}

function detectLanguage(text: string): SupportedLang {
  const normalized = normalizeText(text)
  const scores = (Object.keys(grammar.languages) as SupportedLang[]).map((lang) => {
    const rules = grammar.languages[lang]
    let score = 0
    if (containsAny(normalized, rules.call_verbs)) score += 3
    if (containsAny(normalized, rules.call_nouns)) score += 2
    if (containsAny(normalized, rules.me_pronouns)) score += 2
    if (containsAny(normalized, rules.now_indicators)) score += 1
    if (containsAny(normalized, rules.delay_indicators)) score += 1
    return { lang, score }
  })
  scores.sort((a, b) => b.score - a.score)
  if (!scores[0] || scores[0].score <= 0) return 'en'
  return scores[0].lang
}

function parseDelaySeconds(text: string, lang: SupportedLang): number | null {
  const normalized = normalizeText(text)
  const rules = grammar.languages[lang]
  const unitEntries = Object.entries(rules.time_units).sort((a, b) => b[0].length - a[0].length)
  const numberWordEntries = Object.entries(rules.number_words).sort((a, b) => b[0].length - a[0].length)

  for (const [unit, unitSeconds] of unitEntries) {
    const unitNorm = normalizeText(unit)
    const digitRegex = new RegExp(`(\\d{1,4}(?:[.,]\\d+)?)\\s*${escapeRegex(unitNorm)}\\b`, 'i')
    const digitMatch = normalized.match(digitRegex)
    if (digitMatch) {
      const value = Number(digitMatch[1].replace(',', '.'))
      if (Number.isFinite(value) && value > 0) {
        return Math.min(Math.round(value * unitSeconds), MAX_DELAY_SECONDS)
      }
    }
  }

  for (const [word, value] of numberWordEntries) {
    const wordNorm = normalizeText(word)
    for (const [unit, unitSeconds] of unitEntries) {
      const unitNorm = normalizeText(unit)
      const wordUnitRegex = new RegExp(`(^|\\W)${escapeRegex(wordNorm)}\\s+${escapeRegex(unitNorm)}(\\W|$)`, 'i')
      if (wordUnitRegex.test(normalized)) {
        return Math.min(Math.round(value * unitSeconds), MAX_DELAY_SECONDS)
      }
    }
  }

  const vagueLater = ['spater', 'later', 'mas tarde', 'nachher', 'luego']
  if (containsAny(normalized, vagueLater)) return 300
  return null
}

function getNowInTimezone(timezone?: string, now?: Date): Date {
  const base = now || new Date()
  const tz = String(timezone || '').trim()
  if (!tz) return base
  try {
    return new Date(base.toLocaleString('en-US', { timeZone: tz }))
  } catch {
    return base
  }
}

function parseClockTimeFromText(text: string, lang: SupportedLang): { hour24: number; minute: number } | null {
  const normalized = normalizeText(text)
  const patternsByLang: Record<SupportedLang, RegExp[]> = {
    de: [/\bum\s+(\d{1,2})(?::(\d{2}))?\b/i, /\bgegen\s+(\d{1,2})(?::(\d{2}))?\b/i],
    en: [/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i],
    es: [/\ba\s+las\s+(\d{1,2})(?::(\d{2}))?\b/i, /\ba\s+la\s+(\d{1,2})(?::(\d{2}))?\b/i],
  }
  for (const rx of patternsByLang[lang]) {
    const m = normalized.match(rx)
    if (!m) continue
    let hour = Number(m[1] || 0)
    const minute = Number(m[2] || 0)
    const ampm = String(m[3] || '').toLowerCase()
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) continue
    if (minute < 0 || minute > 59) continue
    if (ampm === 'pm' && hour < 12) hour += 12
    if (ampm === 'am' && hour === 12) hour = 0
    if (hour < 0 || hour > 23) continue
    return { hour24: hour, minute }
  }
  return null
}

function parseScheduledClockDelaySeconds(text: string, lang: SupportedLang, timezone?: string, now?: Date): number | null {
  const clock = parseClockTimeFromText(text, lang)
  if (!clock) return null
  const localNow = getNowInTimezone(timezone, now)
  const target = new Date(localNow)
  target.setSeconds(0, 0)
  target.setHours(clock.hour24, clock.minute, 0, 0)
  if (target.getTime() <= localNow.getTime()) {
    target.setDate(target.getDate() + 1)
  }
  const diffSeconds = Math.round((target.getTime() - localNow.getTime()) / 1000)
  if (!Number.isFinite(diffSeconds) || diffSeconds <= 0) return null
  return Math.min(diffSeconds, MAX_DELAY_SECONDS)
}

function classifyIntent(
  text: string,
  lang: SupportedLang,
  options?: { timezone?: string; now?: Date },
): { intent: 'call_now' | 'call_delayed'; confidence: number; delaySeconds: number } | null {
  const normalized = normalizeText(text)
  const looksLikeCallMemoryTalk =
    /\b(im|in|unserem|our|this|en|del)\s+call\b/i.test(normalized) ||
    /\b(last|letzten?|previous|anterior|ultimo|último)\s+call\b/i.test(normalized) ||
    /\b(call|anruf|llamada)\s+(war|was|fue|went|gesprochen|talked|discussed|summary|zusammenfassung|resumen)\b/i.test(
      normalized,
    )
  if (looksLikeCallMemoryTalk) return null

  const nowPatternsByLang: Record<SupportedLang, RegExp[]> = {
    de: [
      /\bruf(?:e)?\s+mich\s+(?:jetzt|gleich|sofort|direkt|bitte|mal|kurz|\s)*an\b/i,
      /\bkannst\s+du\s+mich\s+anrufen\b/i,
    ],
    en: [/\bcall\s+me(?:\s+now)?\b/i, /\bcan\s+you\s+call\s+me\b/i],
    es: [/\bll[aá]mame(?:\s+ahora)?\b/i, /\bpuedes\s+llamarme\b/i],
  }
  const delayedPatternsByLang: Record<SupportedLang, RegExp[]> = {
    de: [/\bruf(?:e)?\s+mich\s+(?:in|um)\b/i, /\bkannst\s+du\s+mich\s+(?:in|um)\b/i],
    en: [/\bcall\s+me\s+(?:in|at)\b/i, /\bcan\s+you\s+call\s+me\s+(?:in|at)\b/i],
    es: [/\bll[aá]mame\s+(?:en|a\s+las|a\s+la)\b/i, /\bpuedes\s+llamarme\s+(?:en|a\s+las|a\s+la)\b/i],
  }

  const isDirectNow = nowPatternsByLang[lang].some((rx) => rx.test(text))
  const isDirectDelayed = delayedPatternsByLang[lang].some((rx) => rx.test(text))

  if (isDirectDelayed) {
    const parsedDelay = parseDelaySeconds(text, lang)
    if (parsedDelay && parsedDelay > 0) {
      return { intent: 'call_delayed', confidence: 0.95, delaySeconds: parsedDelay }
    }
    const scheduledClockDelay = parseScheduledClockDelaySeconds(text, lang, options?.timezone, options?.now)
    if (scheduledClockDelay && scheduledClockDelay > 0) {
      return { intent: 'call_delayed', confidence: 0.95, delaySeconds: scheduledClockDelay }
    }
  }

  if (isDirectNow) {
    return { intent: 'call_now', confidence: 0.95, delaySeconds: 0 }
  }

  return null
}

function toDelayMinutes(delaySeconds: number): number {
  const minutes = Math.max(0, Math.ceil(delaySeconds / 60))
  return Math.min(minutes, MAX_DELAY_MINUTES)
}

export function parseOutboundCallIntent(
  input: string,
  options?: { timezone?: string; now?: Date },
): OutboundCallIntent | null {
  const text = String(input || '').trim()
  if (!text) return null
  const lang = detectLanguage(text)
  const result = classifyIntent(text, lang, options)
  if (!result) return null
  return { delayMinutes: toDelayMinutes(result.delaySeconds), mode: 'video' }
}

export function parseAvatarOutboundCallIntent(input: string): OutboundCallIntent | null {
  const text = String(input || '').trim()
  if (!text) return null
  const lang = detectLanguage(text)
  const rules = grammar.languages[lang]
  const normalized = normalizeText(text)

  if (containsAny(normalized, rules.avatar_suggest_triggers)) {
    return { delayMinutes: 0, mode: 'video' }
  }

  const nowPatternsByLang: Record<SupportedLang, RegExp[]> = {
    de: [/\bich\s+rufe\s+dich\s+(?:jetzt|gleich|direkt|sofort|mal|kurz|\s)*an\b/i],
    en: [/\bi(?:'ll| will)\s+call\s+you(?:\s+now)?\b/i],
    es: [/\bte\s+llamo(?:\s+ahora)?\b/i],
  }
  const delayedPatternsByLang: Record<SupportedLang, RegExp[]> = {
    de: [/\bich\s+rufe\s+dich\s+(?:in|um)\b/i],
    en: [/\bi(?:'ll| will)\s+call\s+you\s+(?:in|at)\b/i],
    es: [/\bte\s+llamo\s+(?:en|a\s+las|a\s+la)\b/i],
  }

  const isDirectNow = nowPatternsByLang[lang].some((rx) => rx.test(text))
  const isDirectDelayed = delayedPatternsByLang[lang].some((rx) => rx.test(text))
  if (!isDirectNow && !isDirectDelayed) return null

  const parsedDelay = parseDelaySeconds(text, lang)
  if (parsedDelay && parsedDelay > 0) return { delayMinutes: toDelayMinutes(parsedDelay), mode: 'video' }

  const scheduledClockDelay = parseScheduledClockDelaySeconds(text, lang)
  if (scheduledClockDelay && scheduledClockDelay > 0) {
    return { delayMinutes: toDelayMinutes(scheduledClockDelay), mode: 'video' }
  }

  return { delayMinutes: 0, mode: 'video' }
}

function formatDelayHuman(delayMinutes: number, lang: SupportedLang): string {
  if (delayMinutes <= 1) {
    if (lang === 'de') return '1 Minute'
    if (lang === 'es') return '1 minuto'
    return '1 minute'
  }
  if (delayMinutes < 60) {
    if (lang === 'de') return `${delayMinutes} Minuten`
    if (lang === 'es') return `${delayMinutes} minutos`
    return `${delayMinutes} minutes`
  }
  const hours = Math.floor(delayMinutes / 60)
  const minutes = delayMinutes % 60
  if (lang === 'de') return minutes ? `${hours} Std ${minutes} Min` : `${hours} Stunden`
  if (lang === 'es') return minutes ? `${hours} h ${minutes} min` : `${hours} horas`
  return minutes ? `${hours}h ${minutes}m` : `${hours} hours`
}

export function buildOutboundCallAck(text: string, delayMinutes: number) {
  const lang = detectLanguage(text)
  const templates = grammar.response_templates[lang] || grammar.response_templates.en
  if (delayMinutes <= 0) return templates.call_now_confirm
  return templates.call_delayed_confirm.replace('{delay_human}', formatDelayHuman(delayMinutes, lang))
}
