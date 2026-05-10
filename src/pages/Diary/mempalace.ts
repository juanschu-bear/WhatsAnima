const DIARY_API_BASE = 'https://boardroom-api.onioko.com/api/diary'

export interface RawEntry {
  date: string
  timestamp?: string
  created_at?: string
  ts?: string
  topic?: string
  content: string
}

export interface DiaryReadResponse {
  agent: string
  entries: RawEntry[]
  total: number
  showing: number
}

export interface ParsedEntry {
  date: string
  timestamp?: string
  title: string
  text: string
  tags: ParsedTag[]
}

export interface ParsedTag {
  type: 'skill' | 'pattern' | 'contact' | 'other'
  value: string
  raw: string
}

export interface ApiAvatar {
  agent_id: string
  name?: string
  initials?: string
  expertise?: string
  role?: string
  wing?: string
  number?: string
  type?: string
  entry_count: number
}

export async function fetchDiary(agentId: string, lastN = 50): Promise<DiaryReadResponse> {
  const res = await fetch(`${DIARY_API_BASE}/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: agentId, last_n: lastN }),
  })
  if (!res.ok) throw new Error(`Diary API ${res.status}`)
  return res.json()
}

export async function fetchAvatars(): Promise<ApiAvatar[]> {
  const res = await fetch(`${DIARY_API_BASE}/avatars`)
  if (!res.ok) throw new Error(`Diary API ${res.status}`)
  const data = (await res.json()) as { avatars?: ApiAvatar[] } | ApiAvatar[]
  if (Array.isArray(data)) return data
  return data.avatars ?? []
}

function classifyTag(raw: string): ParsedTag {
  const trimmed = raw.trim()
  const slashIdx = trimmed.indexOf('/')
  if (slashIdx === -1) return { type: 'other', value: trimmed, raw: trimmed }
  const type = trimmed.slice(0, slashIdx).toLowerCase()
  const value = trimmed.slice(slashIdx + 1)
  if (type === 'skill' || type === 'pattern' || type === 'contact') {
    return { type, value, raw: trimmed }
  }
  return { type: 'other', value: trimmed, raw: trimmed }
}

export function parseEntry(raw: RawEntry): ParsedEntry {
  const content = (raw.content ?? '').trim()
  const lines = content.split(/\r?\n/)

  let title = ''
  let body = content
  let tags: ParsedTag[] = []

  // Tags: last line starting with "Tags:"
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim()
    if (l.toLowerCase().startsWith('tags:')) {
      const tagStr = l.slice(5).trim()
      tags = tagStr.split(',').map((t) => classifyTag(t)).filter((t) => t.value.length > 0)
      lines.splice(i, 1)
      body = lines.join('\n').trim()
      break
    }
  }

  if (body.toUpperCase().startsWith('TITLE:')) {
    const bodyLines = body.split(/\r?\n/)
    title = bodyLines[0].slice(6).trim()
    body = bodyLines.slice(1).join('\n').trim()
  } else {
    const words = body.split(/\s+/).filter(Boolean)
    title = words.slice(0, 5).join(' ')
    if (words.length > 5) title += '…'
  }

  return {
    date: raw.date,
    timestamp: raw.timestamp ?? raw.created_at ?? raw.ts,
    title,
    text: body,
    tags,
  }
}

/**
 * Drop near-duplicate entries: same title written within 5 minutes,
 * keep only the newer one. Server sometimes double-writes.
 */
export function dedupEntries(entries: ParsedEntry[]): ParsedEntry[] {
  const sorted = [...entries].sort((a, b) =>
    (b.timestamp ?? '').localeCompare(a.timestamp ?? ''),
  )
  const kept: ParsedEntry[] = []
  for (const e of sorted) {
    const eTs = e.timestamp ? Date.parse(e.timestamp) : NaN
    const dup = kept.find((k) => {
      if (k.title.trim() !== e.title.trim()) return false
      const kTs = k.timestamp ? Date.parse(k.timestamp) : NaN
      if (Number.isNaN(eTs) || Number.isNaN(kTs)) return true
      return Math.abs(kTs - eTs) < 300_000
    })
    if (!dup) kept.push(e)
  }
  return kept
}

export interface SkillCount {
  name: string
  count: number
}

export function extractSkills(entries: ParsedEntry[]): SkillCount[] {
  const counts = new Map<string, number>()
  for (const e of entries) {
    for (const t of e.tags) {
      if (t.type === 'skill') {
        counts.set(t.value, (counts.get(t.value) ?? 0) + 1)
      }
    }
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
}

export interface DayGroup {
  date: string
  entries: ParsedEntry[]
}

export function groupByDay(entries: ParsedEntry[]): DayGroup[] {
  const map = new Map<string, ParsedEntry[]>()
  for (const e of entries) {
    if (!map.has(e.date)) map.set(e.date, [])
    map.get(e.date)!.push(e)
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''))
  }
  return Array.from(map.entries())
    .map(([date, entries]) => ({ date, entries }))
    .sort((a, b) => b.date.localeCompare(a.date))
}

export interface TagAggregate {
  name: string
  displayName: string
  count: number
  description: string
  since: string
  latestDate: string
  recentTitles: string[]
}

function titleCase(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function firstSentence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const m = trimmed.match(/[^.!?]+[.!?]/)
  if (m) return m[0].trim()
  return trimmed.length > 160 ? trimmed.slice(0, 157) + '…' : trimmed
}

export function aggregateByTagType(
  entries: ParsedEntry[],
  type: 'skill' | 'pattern' | 'contact',
): TagAggregate[] {
  const buckets = new Map<string, ParsedEntry[]>()
  for (const e of entries) {
    const seen = new Set<string>()
    for (const t of e.tags) {
      if (t.type !== type) continue
      const key = t.value
      if (seen.has(key)) continue
      seen.add(key)
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key)!.push(e)
    }
  }

  const result: TagAggregate[] = []
  for (const [name, list] of buckets) {
    const sortedAsc = [...list].sort((a, b) =>
      (a.timestamp ?? a.date).localeCompare(b.timestamp ?? b.date),
    )
    const sortedDesc = [...sortedAsc].reverse()
    const newest = sortedDesc[0]
    const oldest = sortedAsc[0]
    result.push({
      name,
      displayName: type === 'contact' ? name : titleCase(name),
      count: list.length,
      description: firstSentence(newest.text || newest.title),
      since: oldest.date,
      latestDate: newest.date,
      recentTitles: sortedDesc.slice(0, 3).map((e) => e.title),
    })
  }
  return result.sort((a, b) => b.count - a.count)
}
