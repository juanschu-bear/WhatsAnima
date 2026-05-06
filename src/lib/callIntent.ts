export interface OutboundCallIntent {
  delayMinutes: number
  mode: 'video'
}

const VIDEO_HINTS = /\b(video|videocall|video call|videollamada|videoanruf)\b/i

const IMMEDIATE_PATTERNS = [
  /\bcall me(?: now)?\b/i,
  /\bruf mich(?: mal)?(?: bitte)?(?: jetzt| gleich| kurz)? an\b/i,
  /\bll[aá]mame(?: ahora| ya| enseguida)?\b/i,
]

const SCHEDULED_PATTERNS: RegExp[] = [
  /\bcall me in\s+(\d{1,3})\s*(minutes?|mins?)\b/i,
  /\bruf mich(?: mal)?(?: bitte)? in\s+(\d{1,3})\s*(minuten|min)\s+an\b/i,
  /\bll[aá]mame en\s+(\d{1,3})\s*(minutos|min)\b/i,
]

export function parseOutboundCallIntent(input: string): OutboundCallIntent | null {
  const text = String(input || '').trim()
  if (!text) return null

  for (const pattern of SCHEDULED_PATTERNS) {
    const match = text.match(pattern)
    if (match) {
      const minutes = Number(match[1])
      if (Number.isFinite(minutes) && minutes > 0 && minutes <= 720) {
        return { delayMinutes: minutes, mode: VIDEO_HINTS.test(text) ? 'video' : 'video' }
      }
    }
  }

  if (IMMEDIATE_PATTERNS.some((pattern) => pattern.test(text))) {
    return { delayMinutes: 0, mode: VIDEO_HINTS.test(text) ? 'video' : 'video' }
  }

  return null
}

const AVATAR_IMMEDIATE_PATTERNS: RegExp[] = [
  /\bi(?:'| wi)?ll call you(?: now| right now| right away)?\b/i,
  /\bich rufe dich(?: jetzt| gleich| kurz)?(?: an)?\b/i,
  /\bte llamo(?: ahora| ya| enseguida)?\b/i,
]

const AVATAR_SCHEDULED_PATTERNS: RegExp[] = [
  /\bi(?:'| wi)?ll call you in\s+(\d{1,3})\s*(minutes?|mins?)\b/i,
  /\bich rufe dich in\s+(\d{1,3})\s*(minuten|min)\s*(?:an)?\b/i,
  /\bte llamo en\s+(\d{1,3})\s*(minutos|min)\b/i,
]

export function parseAvatarOutboundCallIntent(input: string): OutboundCallIntent | null {
  const text = String(input || '').trim()
  if (!text) return null

  for (const pattern of AVATAR_SCHEDULED_PATTERNS) {
    const match = text.match(pattern)
    if (!match) continue
    const minutes = Number(match[1])
    if (Number.isFinite(minutes) && minutes > 0 && minutes <= 720) {
      return { delayMinutes: minutes, mode: 'video' }
    }
  }

  if (AVATAR_IMMEDIATE_PATTERNS.some((pattern) => pattern.test(text))) {
    return { delayMinutes: 0, mode: 'video' }
  }

  return null
}

export function buildOutboundCallAck(text: string, delayMinutes: number) {
  const isGerman = /\b(ruf mich|bitte|gleich|jetzt|minuten)\b/i.test(text)
  const isSpanish = /\b(ll[aá]mame|ahora|enseguida|minutos)\b/i.test(text)

  if (delayMinutes <= 0) {
    if (isGerman) return 'Alles klar. Ich starte gleich einen Videoanruf.'
    if (isSpanish) return 'Perfecto. Te llamo por video enseguida.'
    return 'Alright. I am starting a video call right away.'
  }

  if (isGerman) return `Alles klar. Ich rufe dich in ${delayMinutes} Minuten per Video an.`
  if (isSpanish) return `Perfecto. Te llamo por video en ${delayMinutes} minutos.`
  return `Alright. I will video call you in ${delayMinutes} minutes.`
}
