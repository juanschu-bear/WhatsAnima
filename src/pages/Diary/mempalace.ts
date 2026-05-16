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
  let hadTagsLine = false

  // Tags: last line starting with "Tags:"
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim()
    if (l.toLowerCase().startsWith('tags:')) {
      const tagStr = l.slice(5).trim()
      tags = tagStr.split(',').map((t) => classifyTag(t)).filter((t) => t.value.length > 0)
      lines.splice(i, 1)
      body = lines.join('\n').trim()
      hadTagsLine = true
      break
    }
  }

  if (body.toUpperCase().startsWith('TITLE:')) {
    const bodyLines = body.split(/\r?\n/)
    title = bodyLines[0].slice(6).trim()
    body = bodyLines.slice(1).join('\n').trim()
  } else {
    // New format: first non-empty line is the title (entry has Tags or
    // looks structured — first line short, more body follows).
    const bodyLines = body.split(/\r?\n/)
    const firstIdx = bodyLines.findIndex((l) => l.trim().length > 0)
    const firstLine = firstIdx >= 0 ? bodyLines[firstIdx].trim() : ''
    const rest = firstIdx >= 0
      ? bodyLines.slice(firstIdx + 1).join('\n').trim()
      : ''
    const looksLikeTitle =
      firstLine.length > 0 &&
      firstLine.length <= 120 &&
      rest.length > 0 &&
      !/^[*#>\-]/.test(firstLine)

    if (hadTagsLine || looksLikeTitle) {
      // Strip leading markdown bold/heading markers if present
      title = firstLine.replace(/^\*\*(.+?)\*\*$/, '$1').replace(/^#+\s*/, '').trim()
      body = rest
    } else {
      // Old / unstructured entry — short excerpt as title, leave body intact
      const flat = body.replace(/\s+/g, ' ').trim()
      title = flat.length > 30 ? flat.slice(0, 30).trimEnd() + '…' : flat
    }
  }

  return {
    date: raw.date,
    timestamp: raw.timestamp ?? raw.created_at ?? raw.ts ?? raw.date,
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

function dayKey(date: string): string {
  const m = date.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : date
}

export function groupByDay(entries: ParsedEntry[]): DayGroup[] {
  const map = new Map<string, ParsedEntry[]>()
  for (const e of entries) {
    const k = dayKey(e.date)
    if (!map.has(k)) map.set(k, [])
    map.get(k)!.push(e)
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''))
  }
  return Array.from(map.entries())
    .map(([date, entries]) => ({ date, entries }))
    .sort((a, b) => b.date.localeCompare(a.date))
}

export interface TagAggregateMemory {
  date: string
  title: string
  excerpt: string
}

export type TagTrend = 'new' | 'growing' | 'stable' | 'improving' | 'resolved'

export interface TagAggregate {
  name: string
  displayName: string
  count: number
  description: string
  since: string
  latestDate: string
  recentTitles: string[]
  memories: TagAggregateMemory[]
  beforeCount: number
  afterCount: number
  trend: TagTrend
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

  const entriesDesc = [...entries].sort((a, b) =>
    (b.timestamp ?? b.date).localeCompare(a.timestamp ?? a.date),
  )
  const mid = Math.floor(entriesDesc.length / 2)
  const newerSet = new Set(entriesDesc.slice(0, mid))
  const olderSet = new Set(entriesDesc.slice(mid))

  const result: TagAggregate[] = []
  for (const [name, list] of buckets) {
    const sortedAsc = [...list].sort((a, b) =>
      (a.timestamp ?? a.date).localeCompare(b.timestamp ?? b.date),
    )
    const sortedDesc = [...sortedAsc].reverse()
    const newest = sortedDesc[0]
    const oldest = sortedAsc[0]
    let beforeCount = 0
    let afterCount = 0
    for (const e of list) {
      if (newerSet.has(e)) afterCount++
      else if (olderSet.has(e)) beforeCount++
    }
    const trend = computeTrend(type, beforeCount, afterCount)
    result.push({
      name,
      displayName: type === 'contact' ? name : titleCase(name),
      count: list.length,
      description: firstSentence(newest.text || newest.title),
      since: oldest.date,
      latestDate: newest.date,
      recentTitles: sortedDesc.slice(0, 3).map((e) => e.title),
      memories: sortedDesc.map((e) => ({
        date: e.date,
        title: e.title,
        excerpt: firstSentence(e.text || e.title),
      })),
      beforeCount,
      afterCount,
      trend,
    })
  }
  return result.sort((a, b) => b.count - a.count)
}

function computeTrend(
  type: 'skill' | 'pattern' | 'contact',
  before: number,
  after: number,
): TagTrend {
  if (type === 'pattern') {
    if (before > 0 && after === 0) return 'resolved'
    if (before > after && after > 0) return 'improving'
    if (before === 0 && after > 0) return 'growing'
    return 'stable'
  }
  if (before === 0 && after > 0) return 'new'
  if (after > before) return 'growing'
  if (after < before && after > 0) return 'improving'
  if (before > 0 && after === 0) return 'resolved'
  return 'stable'
}

export interface GrowthSignals {
  growthScore: number
  behavioralChange: number
  diaryImpact: number
  totalEntries: number
  patternsImproving: number
  patternsTotal: number
  appliedRatio: number
  behavioralChanges: BehavioralChange[]
  impactEntries: ImpactEntry[]
}

export interface BehavioralChange {
  kind: TagTrend
  type: 'skill' | 'pattern'
  name: string
  displayName: string
  description: string
  before: number
  after: number
}

export interface ImpactEntry {
  date: string
  timestamp?: string
  title: string
  text: string
  applied: number
}

export function computeGrowthSignals(entries: ParsedEntry[]): GrowthSignals {
  const skills = aggregateByTagType(entries, 'skill')
  const patterns = aggregateByTagType(entries, 'pattern')

  const skillsGrowing = skills.filter((s) => s.trend === 'growing' || s.trend === 'new').length
  const patternsImproving = patterns.filter(
    (p) => p.trend === 'improving' || p.trend === 'resolved',
  ).length
  const patternsTotal = patterns.length

  const behavioralChanges: BehavioralChange[] = []
  for (const p of patterns) {
    if (p.trend === 'resolved' || p.trend === 'improving') {
      behavioralChanges.push({
        kind: p.trend,
        type: 'pattern',
        name: p.name,
        displayName: p.displayName,
        description: p.description,
        before: p.beforeCount,
        after: p.afterCount,
      })
    }
  }
  for (const s of skills) {
    if (s.trend === 'new' || s.trend === 'growing') {
      behavioralChanges.push({
        kind: s.trend,
        type: 'skill',
        name: s.name,
        displayName: s.displayName,
        description: s.description,
        before: s.beforeCount,
        after: s.afterCount,
      })
    }
  }

  const entriesAsc = [...entries].sort((a, b) =>
    (a.timestamp ?? a.date).localeCompare(b.timestamp ?? b.date),
  )
  const impactEntries: ImpactEntry[] = []
  for (let i = 0; i < entriesAsc.length; i++) {
    const e = entriesAsc[i]
    const laterEntries = entriesAsc.slice(i + 1)
    const ownSkills = new Set(
      e.tags.filter((t) => t.type === 'skill').map((t) => t.value),
    )
    if (ownSkills.size === 0) continue
    let applied = 0
    for (const later of laterEntries) {
      for (const lt of later.tags) {
        if (lt.type === 'skill' && ownSkills.has(lt.value)) {
          applied++
          break
        }
      }
    }
    impactEntries.push({
      date: e.date,
      timestamp: e.timestamp,
      title: e.title,
      text: e.text,
      applied,
    })
  }
  impactEntries.sort((a, b) => b.applied - a.applied || (b.timestamp ?? b.date).localeCompare(a.timestamp ?? a.date))

  const totalEntries = entries.length
  const appliedCount = impactEntries.filter((i) => i.applied > 0).length
  const appliedRatio = impactEntries.length > 0 ? appliedCount / impactEntries.length : 0

  const growthScore = Math.min(
    100,
    Math.round((skillsGrowing * 8 + patternsImproving * 6 + Math.min(totalEntries, 30) * 1.2)),
  )
  const behavioralChange =
    patternsTotal > 0 ? Math.round((patternsImproving / patternsTotal) * 100) : 0
  const diaryImpact = Math.round(appliedRatio * 100)

  return {
    growthScore,
    behavioralChange,
    diaryImpact,
    totalEntries,
    patternsImproving,
    patternsTotal,
    appliedRatio,
    behavioralChanges,
    impactEntries: impactEntries.slice(0, 8),
  }
}
