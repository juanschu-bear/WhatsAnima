const MEMPALACE_BASE = 'https://mempalace.onioko.com'

export interface RawEntry {
  date: string
  timestamp?: string
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

export async function fetchDiary(agentId: string, lastN = 50): Promise<DiaryReadResponse> {
  const res = await fetch(`${MEMPALACE_BASE}/diary/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: agentId, last_n: lastN }),
  })
  if (!res.ok) throw new Error(`MemPalace ${res.status}`)
  return res.json()
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
    timestamp: raw.timestamp,
    title,
    text: body,
    tags,
  }
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
