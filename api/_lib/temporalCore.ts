export type TemporalLang = 'de' | 'en' | 'es'

export function normalizeTimezone(value: unknown): string {
  const tz = String(value || '').trim()
  if (!tz || !tz.includes('/')) return 'UTC'
  return tz
}

export function normalizeTemporalLang(value: unknown): TemporalLang {
  const lang = String(value || '').toLowerCase()
  if (lang.startsWith('de')) return 'de'
  if (lang.startsWith('es')) return 'es'
  return 'en'
}

function localeFor(lang: TemporalLang): string {
  if (lang === 'de') return 'de-DE'
  if (lang === 'es') return 'es-ES'
  return 'en-US'
}

export function getDayContext(date: Date, timezone: string, lang: TemporalLang): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hour12: false }).format(date),
  )
  const isWeekend = ['Sat', 'Sun'].includes(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(date),
  )

  let part = 'daytime'
  if (hour < 6) part = 'late night'
  else if (hour < 12) part = 'morning'
  else if (hour < 18) part = 'afternoon'
  else if (hour < 22) part = 'evening'
  else part = 'night'

  if (lang === 'de') {
    const partMap: Record<string, string> = {
      'late night': 'späte Nacht',
      morning: 'Vormittag',
      afternoon: 'Nachmittag',
      evening: 'Abend',
      night: 'Nacht',
      daytime: 'Tag',
    }
    return isWeekend ? `Wochenende, ${partMap[part] || part}` : `Werktag, ${partMap[part] || part}`
  }
  if (lang === 'es') return isWeekend ? `fin de semana, ${part}` : `día laboral, ${part}`
  return isWeekend ? `Weekend, ${part}` : `Regular weekday, ${part}`
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000)
}

function formatDateForPrompt(date: Date, timezone: string, lang: TemporalLang, includeWeekday = true): string {
  return new Intl.DateTimeFormat(localeFor(lang), {
    timeZone: timezone,
    weekday: includeWeekday ? 'long' : undefined,
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

export function buildReferenceTimes(now: Date, timezone: string, lang: TemporalLang): Array<{ label: string; value: string }> {
  const entries = [
    { key: 'in_30', delta: 30 },
    { key: 'in_60', delta: 60 },
    { key: 'in_120', delta: 120 },
    { key: 'in_180', delta: 180 },
    { key: 'in_360', delta: 360 },
    { key: 'in_720', delta: 720 },
    { key: 'tomorrow', delta: 1440 },
    { key: 'yesterday', delta: -1440 },
  ]

  const labelMap: Record<TemporalLang, Record<string, string>> = {
    de: {
      in_30: 'In 30 Min',
      in_60: 'In 1 Stunde',
      in_120: 'In 2 Stunden',
      in_180: 'In 3 Stunden',
      in_360: 'In 6 Stunden',
      in_720: 'In 12 Stunden',
      tomorrow: 'Morgen gleiche Uhrzeit',
      yesterday: 'Gestern gleiche Uhrzeit',
    },
    es: {
      in_30: 'En 30 min',
      in_60: 'En 1 hora',
      in_120: 'En 2 horas',
      in_180: 'En 3 horas',
      in_360: 'En 6 horas',
      in_720: 'En 12 horas',
      tomorrow: 'Mañana, misma hora',
      yesterday: 'Ayer, misma hora',
    },
    en: {
      in_30: 'In 30 min',
      in_60: 'In 1 hour',
      in_120: 'In 2 hours',
      in_180: 'In 3 hours',
      in_360: 'In 6 hours',
      in_720: 'In 12 hours',
      tomorrow: 'Tomorrow same time',
      yesterday: 'Yesterday same time',
    },
  }

  return entries.map((entry) => ({
    label: labelMap[lang][entry.key],
    value: formatDateForPrompt(addMinutes(now, entry.delta), timezone, lang, true),
  }))
}

export function buildCurrentTimeContext(timezoneRaw: unknown, langRaw: unknown): string {
  const timezone = normalizeTimezone(timezoneRaw)
  const lang = normalizeTemporalLang(langRaw)
  const now = new Date()
  const nowHuman = formatDateForPrompt(now, timezone, lang, true)
  const dayContext = getDayContext(now, timezone, lang)
  const references = buildReferenceTimes(now, timezone, lang)
  const refBlock = references.map((r) => `  ${r.label}: ${r.value}`).join('\n')

  const instruction =
    lang === 'de'
      ? 'Time instruction: Du hast ein natürliches Zeitgefühl, antworte menschlich. Nutze die Referenzzeiten für Zeitrechnung. Wenn die Person eine vage Zeit nennt, verhandle freundlich auf eine konkrete Uhrzeit.'
      : lang === 'es'
        ? 'Time instruction: Tienes sentido natural del tiempo, responde de forma humana. Usa las referencias para cálculos. Si el usuario da un tiempo vago, negocia una hora concreta.'
        : 'Time instruction: You have a natural sense of time, answer conversationally. Use the reference times for arithmetic. If the user gives a vague time, negotiate a specific time.'

  return `[CURRENT TIME]
Right now: ${nowHuman} (${timezone})
Day context: ${dayContext}

Reference times for calculation:
${refBlock}

${instruction}`
}

export function buildNaturalTimeReply(message: string, timezoneRaw: unknown, langRaw: unknown): string {
  const timezone = normalizeTimezone(timezoneRaw)
  const lang = normalizeTemporalLang(langRaw)
  const now = new Date()

  const timeOnly = new Intl.DateTimeFormat(localeFor(lang), {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)
  const day = new Intl.DateTimeFormat(localeFor(lang), {
    timeZone: timezone,
    weekday: 'long',
  }).format(now)

  const lower = message.toLowerCase()
  const asksDate = /\b(date|datum|día|dia)\b/.test(lower)
  const asksDay = /\b(day|tag|día|dia)\b/.test(lower)

  if (lang === 'de') {
    if (asksDate) {
      const d = new Intl.DateTimeFormat('de-DE', {
        timeZone: timezone,
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      }).format(now)
      return `Heute ist ${d}, bei dir ist es gerade ${timeOnly}.`
    }
    if (asksDay) return `Heute ist ${day}, bei dir ist es gerade ${timeOnly}.`
    return `Bei dir ist es gerade ${timeOnly}, ${day}.`
  }
  if (lang === 'es') {
    if (asksDate) {
      const d = new Intl.DateTimeFormat('es-ES', {
        timeZone: timezone,
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      }).format(now)
      return `Hoy es ${d}, ahora mismo son las ${timeOnly}.`
    }
    if (asksDay) return `Hoy es ${day}, ahora mismo son las ${timeOnly}.`
    return `Ahora mismo son las ${timeOnly} para ti, ${day}.`
  }
  if (asksDate) {
    const d = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    }).format(now)
    return `Today is ${d}, and it's currently ${timeOnly} for you.`
  }
  if (asksDay) return `It's ${day} for you, and the time is ${timeOnly}.`
  return `It's currently ${timeOnly} for you, ${day}.`
}
