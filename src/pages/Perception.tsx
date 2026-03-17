import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { resolveAvatarUrl } from '../lib/avatars'

type LanguageFilter = 'All' | 'English' | 'German' | 'Spanish'

interface OwnerRow {
  id: string
  display_name: string | null
}

interface ContactRow {
  id: string
  display_name: string | null
  email: string | null
}

interface ConversationRow {
  id: string
  owner_id: string
  contact_id: string
  created_at: string
  updated_at: string
}

interface MessageRow {
  id: string
  media_url: string | null
  duration_sec: number | null
  type: string | null
  content: string | null
  created_at: string
}

interface PerceptionLogRow {
  id: string
  message_id: string | null
  conversation_id: string
  contact_id: string | null
  owner_id: string | null
  transcript: string | null
  primary_emotion: string | null
  secondary_emotion: string | null
  recommended_tone: string | null
  fired_rules: unknown
  behavioral_summary: string | null
  conversation_hooks: unknown
  prosodic_summary: Record<string, unknown> | null
  audio_duration_sec: number | null
  created_at: string
}

interface PerceptionEntry {
  id: string
  createdAt: string
  conversationId: string
  avatarName: string
  avatarId: string
  avatarImage: string
  contactName: string
  transcript: string
  language: LanguageFilter
  primaryEmotion: string
  secondaryEmotion: string
  recommendedTone: string
  behavioralSummary: string
  conversationHooks: string[]
  firedRules: Array<{ rawName: string; name: string; confidence: number | null; category: string | null }>
  prosodicSummary: Record<string, unknown>
  messageAudioUrl: string | null
  messageDurationSec: number | null
  messageType: string | null
}

interface PerceptionDashboardPayload {
  owners: OwnerRow[]
  contacts: ContactRow[]
  conversations: ConversationRow[]
  messages: MessageRow[]
  logs: PerceptionLogRow[]
}

const LANGUAGE_OPTIONS: LanguageFilter[] = ['All', 'English', 'German', 'Spanish']

const METRIC_CONFIG = [
  { key: 'speaking_rate_wps', label: 'Speaking Rate', unit: 'wps', reference: 'Normal: 1.5–2.5', accent: 'text-cyan-300', transform: (value: number) => value },
  { key: 'voice_stability', label: 'Voice Stability', unit: '%', reference: 'High >85%, Low <70%', accent: 'text-emerald-300', transform: (value: number) => value * 100 },
  { key: 'voice_tremor', label: 'Voice Tremor', unit: '%', reference: 'Low <10%, High >20%', accent: 'text-amber-300', transform: (value: number) => value * 100 },
  { key: 'pitch_range_hz', label: 'Pitch Range', unit: 'Hz', reference: 'Narrow <50, Wide >100', accent: 'text-fuchsia-300', transform: (value: number) => value },
  { key: 'estimated_fundamental_hz', label: 'Fund. Frequency', unit: 'Hz', reference: 'Male: 85–155', accent: 'text-sky-300', transform: (value: number) => value },
  { key: 'mean_volume_db', label: 'Volume', unit: 'dB', reference: 'Quiet <-50, Loud >-35', accent: 'text-rose-300', transform: (value: number) => value },
  { key: 'speech_ratio', label: 'Speech Ratio', unit: '%', reference: '>95% = continuous', accent: 'text-teal-300', transform: (value: number) => value * 100 },
  { key: 'longest_pause_ms', label: 'Longest Pause', unit: 's', reference: '>3s = deliberate', accent: 'text-violet-300', transform: (value: number) => value / 1000 },
  { key: 'average_pause_ms', label: 'Avg Pause', unit: 'ms', reference: 'Normal: 500–1500', accent: 'text-orange-300', transform: (value: number) => value },
] as const

const EMOTION_STYLES: Record<string, { color: string; bg: string; border: string; emoji: string }> = {
  frustrated: { color: 'text-red-300', bg: 'bg-red-500/12', border: 'border-red-400/20', emoji: '😤' },
  anxious: { color: 'text-amber-300', bg: 'bg-amber-500/12', border: 'border-amber-400/20', emoji: '😰' },
  annoyance: { color: 'text-orange-300', bg: 'bg-orange-500/12', border: 'border-orange-400/20', emoji: '😒' },
  admiration: { color: 'text-emerald-300', bg: 'bg-emerald-500/12', border: 'border-emerald-400/20', emoji: '🤩' },
  approval: { color: 'text-blue-300', bg: 'bg-blue-500/12', border: 'border-blue-400/20', emoji: '👍' },
  disapproval: { color: 'text-violet-300', bg: 'bg-violet-500/12', border: 'border-violet-400/20', emoji: '👎' },
  neutral: { color: 'text-slate-300', bg: 'bg-slate-500/12', border: 'border-slate-400/20', emoji: '😐' },
  curiosity: { color: 'text-cyan-300', bg: 'bg-cyan-500/12', border: 'border-cyan-400/20', emoji: '🧐' },
  love: { color: 'text-pink-300', bg: 'bg-pink-500/12', border: 'border-pink-400/20', emoji: '❤️' },
  confusion: { color: 'text-purple-300', bg: 'bg-purple-500/12', border: 'border-purple-400/20', emoji: '😵' },
  disappointment: { color: 'text-gray-300', bg: 'bg-gray-500/12', border: 'border-gray-400/20', emoji: '😞' },
  reflective: { color: 'text-indigo-300', bg: 'bg-indigo-500/12', border: 'border-indigo-400/20', emoji: '🤔' },
  surprise: { color: 'text-fuchsia-300', bg: 'bg-fuchsia-500/12', border: 'border-fuchsia-400/20', emoji: '😲' },
  unknown: { color: 'text-slate-300', bg: 'bg-slate-500/12', border: 'border-slate-400/20', emoji: '😐' },
}

const RULE_STYLES: Record<string, { color: string; bg: string; border: string }> = {
  high_authenticity_composite: { color: 'text-emerald-300', bg: 'bg-emerald-500/12', border: 'border-emerald-400/20' },
  hesitation_cluster: { color: 'text-amber-300', bg: 'bg-amber-500/12', border: 'border-amber-400/20' },
  emotional_escalation: { color: 'text-red-300', bg: 'bg-red-500/12', border: 'border-red-400/20' },
  topic_avoidance_signal: { color: 'text-violet-300', bg: 'bg-violet-500/12', border: 'border-violet-400/20' },
  rehearsed_delivery_pattern: { color: 'text-orange-300', bg: 'bg-orange-500/12', border: 'border-orange-400/20' },
  vocal_incongruence: { color: 'text-pink-300', bg: 'bg-pink-500/12', border: 'border-pink-400/20' },
  low_authenticity_composite: { color: 'text-red-300', bg: 'bg-red-500/12', border: 'border-red-400/20' },
  over_controlled_smoothness: { color: 'text-amber-300', bg: 'bg-amber-500/12', border: 'border-amber-400/20' },
  bimodal_emotional_arc: { color: 'text-cyan-300', bg: 'bg-cyan-500/12', border: 'border-cyan-400/20' },
}

function titleCase(value: string | null | undefined, fallback = 'Unknown') {
  const text = (value || '').trim()
  if (!text) return fallback
  return text
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function detectLanguage(transcript: string): LanguageFilter {
  const text = transcript.toLowerCase()
  const german = (text.match(/\b(ich|und|nicht|aber|habe|hast|sind|danke|bitte|kann|wird|wir|sie|mein|dein|heute)\b/g) ?? []).length
  const spanish = (text.match(/\b(que|pero|como|para|porque|hola|gracias|puedo|tengo|quiero|donde|estoy|esta|muy)\b/g) ?? []).length
  const english = (text.match(/\b(the|and|but|with|have|this|that|hello|thanks|will|your|what|when|where|today)\b/g) ?? []).length
  if (german >= spanish && german >= english && german > 0) return 'German'
  if (spanish >= german && spanish >= english && spanish > 0) return 'Spanish'
  return 'English'
}

function normalizeHooks(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item.trim()
        if (item && typeof item === 'object') {
          const label = (item as Record<string, unknown>).hook || (item as Record<string, unknown>).text || (item as Record<string, unknown>).title
          return typeof label === 'string' ? label.trim() : ''
        }
        return ''
      })
      .filter(Boolean)
  }
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/\n|•|-/)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, '_')
}

function emotionStyle(value: string) {
  return EMOTION_STYLES[normalizeKey(value)] ?? EMOTION_STYLES.unknown
}

function ruleStyle(value: string) {
  return RULE_STYLES[normalizeKey(value)] ?? { color: 'text-cyan-200', bg: 'bg-cyan-500/10', border: 'border-cyan-400/20' }
}

function normalizeRules(value: unknown): Array<{ rawName: string; name: string; confidence: number | null; category: string | null }> {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string') {
        return { rawName: normalizeKey(item), name: titleCase(item), confidence: null, category: null }
      }
      if (!item || typeof item !== 'object') return null
      const obj = item as Record<string, unknown>
      const rawName = (
        typeof obj.name === 'string'
          ? obj.name
          : typeof obj.rule === 'string'
            ? obj.rule
            : typeof obj.label === 'string'
              ? obj.label
              : ''
      ).trim()
      const name = titleCase(
        rawName,
        '',
      )
      if (!name) return null
      return {
        rawName: normalizeKey(rawName),
        name,
        confidence: toNumber(obj.confidence),
        category: typeof obj.category === 'string' ? titleCase(obj.category) : null,
      }
    })
    .filter((item): item is { rawName: string; name: string; confidence: number | null; category: string | null } => Boolean(item))
}

function transcriptParagraphs(transcript: string) {
  return transcript
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function formatDuration(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0m'
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = Math.round(totalSeconds % 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function formatMetric(value: unknown, unit: string) {
  const numeric = toNumber(value)
  if (numeric == null) return '—'
  return `${numeric.toFixed(Math.abs(numeric) >= 10 ? 1 : 3).replace(/\.?0+$/, '')}${unit ? ` ${unit}` : ''}`
}

function metricValue(entry: PerceptionEntry, metric: typeof METRIC_CONFIG[number]) {
  const raw = toNumber(entry.prosodicSummary[metric.key])
  if (raw == null) return null
  return metric.transform(raw)
}

function isEmotionCard(
  card: { label: string; value: string; style?: { color: string; bg: string; border: string; emoji: string }; tone?: string },
): card is { label: string; value: string; style: { color: string; bg: string; border: string; emoji: string } } {
  return Boolean(card.style)
}

function average(values: Array<number | null>) {
  const valid = values.filter((value): value is number => value != null && Number.isFinite(value))
  if (valid.length === 0) return null
  return valid.reduce((sum, value) => sum + value, 0) / valid.length
}

function filterDate(entryDate: string, from: string, to: string) {
  const timestamp = new Date(entryDate).getTime()
  if (from) {
    const fromTimestamp = new Date(`${from}T00:00:00`).getTime()
    if (timestamp < fromTimestamp) return false
  }
  if (to) {
    const toTimestamp = new Date(`${to}T23:59:59.999`).getTime()
    if (timestamp > toTimestamp) return false
  }
  return true
}

export default function Perception() {
  const navigate = useNavigate()
  const { user } = useAuth()

  const [entries, setEntries] = useState<PerceptionEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const [avatarFilter, setAvatarFilter] = useState('All')
  const [languageFilter, setLanguageFilter] = useState<LanguageFilter>('All')
  const [emotionFilter, setEmotionFilter] = useState('All')
  const [ruleFilter, setRuleFilter] = useState('All')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  useEffect(() => {
    if (!user) {
      setLoading(false)
      return
    }

    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const response = await fetch('/api/perception-dashboard')
        const payload = await response.json() as PerceptionDashboardPayload & { error?: string }
        if (!response.ok) {
          throw new Error(payload.error || `Failed to load perception dashboard (${response.status})`)
        }

        const ownerRows = payload.owners ?? []
        const conversationRows = payload.conversations ?? []
        const conversationIds = conversationRows.map((conversation) => conversation.id)
        if (conversationIds.length === 0) {
          if (!cancelled) {
            setEntries([])
            setLoading(false)
          }
          return
        }

        const logRows = payload.logs ?? []
        const contacts = payload.contacts ?? []
        const messages = payload.messages ?? []

        const ownerById = new Map(ownerRows.map((owner) => [owner.id, owner]))
        const contactById = new Map(contacts.map((contact) => [contact.id, contact]))
        const conversationById = new Map(conversationRows.map((conversation) => [conversation.id, conversation]))
        const messageById = new Map(messages.map((message) => [message.id, message]))

        const nextEntries = logRows.map((log) => {
          const conversation = conversationById.get(log.conversation_id)
          const owner = conversation ? ownerById.get(conversation.owner_id) : null
          const contact = conversation ? contactById.get(conversation.contact_id) : null
          const message = log.message_id ? messageById.get(log.message_id) : null
          const transcript = (log.transcript || message?.content || '').trim()
          const avatarName = owner?.display_name?.trim() || 'Avatar'
          return {
            id: log.id,
            createdAt: log.created_at,
            conversationId: log.conversation_id,
            avatarName,
            avatarId: owner?.id || conversation?.owner_id || 'avatar',
            avatarImage: resolveAvatarUrl(avatarName),
            contactName: contact?.display_name?.trim() || contact?.email?.trim() || 'Guest',
            transcript,
            language: detectLanguage(transcript),
            primaryEmotion: titleCase(log.primary_emotion, 'Unknown'),
            secondaryEmotion: titleCase(log.secondary_emotion, 'Unknown'),
            recommendedTone: titleCase(log.recommended_tone, 'Calm, direct'),
            behavioralSummary: (log.behavioral_summary || '').trim(),
            conversationHooks: normalizeHooks(log.conversation_hooks),
            firedRules: normalizeRules(log.fired_rules),
            prosodicSummary: log.prosodic_summary ?? {},
            messageAudioUrl: message?.media_url ?? null,
            messageDurationSec: log.audio_duration_sec ?? message?.duration_sec ?? null,
            messageType: message?.type ?? null,
          } satisfies PerceptionEntry
        })

        if (!cancelled) {
          setEntries(nextEntries)
          setSelectedId((current) => current ?? nextEntries[0]?.id ?? null)
        }
      } catch (loadError) {
        console.error('[Perception] load failed', loadError)
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load perception logs.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [user])

  const avatarOptions = useMemo(
    () => ['All', ...Array.from(new Set(entries.map((entry) => entry.avatarName))).sort()],
    [entries],
  )
  const emotionOptions = useMemo(
    () => ['All', ...Array.from(new Set(entries.flatMap((entry) => [entry.primaryEmotion, entry.secondaryEmotion]).filter(Boolean))).sort()],
    [entries],
  )
  const ruleOptions = useMemo(
    () => ['All', ...Array.from(new Set(entries.flatMap((entry) => entry.firedRules.map((rule) => rule.category || rule.name)).filter(Boolean))).sort()],
    [entries],
  )

  const filteredEntries = useMemo(() => {
    return entries.filter((entry) => {
      if (avatarFilter !== 'All' && entry.avatarName !== avatarFilter) return false
      if (languageFilter !== 'All' && entry.language !== languageFilter) return false
      if (emotionFilter !== 'All' && entry.primaryEmotion !== emotionFilter && entry.secondaryEmotion !== emotionFilter) return false
      if (ruleFilter !== 'All' && !entry.firedRules.some((rule) => rule.name === ruleFilter || rule.category === ruleFilter)) return false
      if (!filterDate(entry.createdAt, dateFrom, dateTo)) return false
      return true
    })
  }, [avatarFilter, dateFrom, dateTo, emotionFilter, entries, languageFilter, ruleFilter])

  useEffect(() => {
    if (filteredEntries.length === 0) {
      setSelectedId(null)
      return
    }
    if (!selectedId || !filteredEntries.some((entry) => entry.id === selectedId)) {
      setSelectedId(filteredEntries[0].id)
    }
  }, [filteredEntries, selectedId])

  const selectedEntry = filteredEntries.find((entry) => entry.id === selectedId) ?? filteredEntries[0] ?? null

  const stats = useMemo(() => {
    const totalDuration = filteredEntries.reduce((sum, entry) => sum + (entry.messageDurationSec ?? 0), 0)
    const avgSpeakingRate = average(
      filteredEntries.map((entry) => toNumber(entry.prosodicSummary.speaking_rate ?? entry.prosodicSummary.speaking_rate_wps)),
    )
    const avgStability = average(
      filteredEntries.map((entry) => toNumber(entry.prosodicSummary.voice_stability ?? entry.prosodicSummary.harmonic_to_noise_ratio)),
    )
    const avgTremor = average(
      filteredEntries.map((entry) => toNumber(entry.prosodicSummary.voice_tremor ?? entry.prosodicSummary.jitter)),
    )
    const rulesFired = filteredEntries.reduce((sum, entry) => sum + entry.firedRules.length, 0)

    return {
      messages: filteredEntries.length,
      totalDuration,
      avgSpeakingRate,
      avgStability,
      avgTremor,
      rulesFired,
    }
  }, [filteredEntries])

  return (
    <div className="h-[100dvh] overflow-hidden bg-[radial-gradient(circle_at_top,rgba(0,195,170,0.12),transparent_30%),radial-gradient(circle_at_82%_18%,rgba(72,137,255,0.12),transparent_24%),linear-gradient(180deg,#04101a_0%,#07111b_55%,#02060b_100%)] text-white">
      <div className="mx-auto flex h-full max-w-[1560px] min-h-0 flex-col px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(9,20,31,0.94),rgba(4,10,18,0.98))] p-5 shadow-[0_30px_120px_rgba(0,0,0,0.35)] sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.35em] text-[#82f8e3]/55">Perception Dashboard</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-white sm:text-4xl">Live Reading Archive</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-white/62 sm:text-[15px]">
                Filter and inspect perception logs across avatars, languages, rules, and time windows.
              </p>
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => navigate('/dashboard')}
                className="rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white/78 transition hover:bg-white/8"
              >
                Dashboard
              </button>
              <button
                type="button"
                onClick={() => navigate('/')}
                className="rounded-2xl border border-[#75f0df]/25 bg-[#0c8a6d]/20 px-4 py-2.5 text-sm text-[#9af8ea] transition hover:border-[#75f0df]/45 hover:text-white"
              >
                Home
              </button>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <label className="flex flex-col gap-2 text-xs uppercase tracking-[0.18em] text-white/45">
              Avatar
              <select value={avatarFilter} onChange={(event) => setAvatarFilter(event.target.value)} className="rounded-2xl border border-white/10 bg-[#08111a] px-4 py-3 text-sm tracking-normal text-white outline-none transition focus:border-[#7cf0e1]/50">
                {avatarOptions.map((option) => <option key={option}>{option}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-2 text-xs uppercase tracking-[0.18em] text-white/45">
              Language
              <select value={languageFilter} onChange={(event) => setLanguageFilter(event.target.value as LanguageFilter)} className="rounded-2xl border border-white/10 bg-[#08111a] px-4 py-3 text-sm tracking-normal text-white outline-none transition focus:border-[#7cf0e1]/50">
                {LANGUAGE_OPTIONS.map((option) => <option key={option}>{option}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-2 text-xs uppercase tracking-[0.18em] text-white/45">
              Emotion
              <select value={emotionFilter} onChange={(event) => setEmotionFilter(event.target.value)} className="rounded-2xl border border-white/10 bg-[#08111a] px-4 py-3 text-sm tracking-normal text-white outline-none transition focus:border-[#7cf0e1]/50">
                {emotionOptions.map((option) => <option key={option}>{option}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-2 text-xs uppercase tracking-[0.18em] text-white/45">
              Rule
              <select value={ruleFilter} onChange={(event) => setRuleFilter(event.target.value)} className="rounded-2xl border border-white/10 bg-[#08111a] px-4 py-3 text-sm tracking-normal text-white outline-none transition focus:border-[#7cf0e1]/50">
                {ruleOptions.map((option) => <option key={option}>{option}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-2 text-xs uppercase tracking-[0.18em] text-white/45">
                From
                <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} className="rounded-2xl border border-white/10 bg-[#08111a] px-4 py-3 text-sm tracking-normal text-white outline-none transition focus:border-[#7cf0e1]/50" />
              </label>
              <label className="flex flex-col gap-2 text-xs uppercase tracking-[0.18em] text-white/45">
                To
                <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} className="rounded-2xl border border-white/10 bg-[#08111a] px-4 py-3 text-sm tracking-normal text-white outline-none transition focus:border-[#7cf0e1]/50" />
              </label>
            </div>
          </div>
        </header>

        <section className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          {[
            { label: 'Messages', value: String(stats.messages) },
            { label: 'Total duration', value: formatDuration(stats.totalDuration) },
            { label: 'Avg speaking rate', value: stats.avgSpeakingRate != null ? `${stats.avgSpeakingRate.toFixed(2)} wps` : '—' },
            { label: 'Avg stability', value: stats.avgStability != null ? stats.avgStability.toFixed(2) : '—' },
            { label: 'Avg tremor', value: stats.avgTremor != null ? stats.avgTremor.toFixed(3) : '—' },
            { label: 'Rules fired', value: String(stats.rulesFired) },
          ].map((stat) => (
            <div key={stat.label} className="rounded-[24px] border border-white/8 bg-[linear-gradient(180deg,rgba(8,18,28,0.92),rgba(5,11,18,0.96))] px-4 py-4 shadow-[0_20px_60px_rgba(0,0,0,0.28)]">
              <div className="text-[11px] uppercase tracking-[0.24em] text-white/40">{stat.label}</div>
              <div className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-white">{stat.value}</div>
            </div>
          ))}
        </section>

        {loading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/10 border-t-[#7cf0e1]" />
          </div>
        ) : error ? (
          <div className="mt-6 rounded-[28px] border border-rose-400/20 bg-rose-500/10 p-6 text-sm text-rose-100">
            {error}
          </div>
        ) : (
          <div className="mt-6 grid min-h-0 flex-1 gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
            <aside className="flex min-h-0 flex-col rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(8,18,28,0.92),rgba(5,11,18,0.96))] p-3 shadow-[0_30px_90px_rgba(0,0,0,0.3)]">
              <div className="flex items-center justify-between px-2 pb-3 pt-1">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.25em] text-white/35">Timeline</p>
                  <p className="mt-1 text-sm text-white/58">{filteredEntries.length} filtered logs</p>
                </div>
              </div>

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                {filteredEntries.map((entry) => {
                  const active = entry.id === selectedEntry?.id
                  const primaryEmotionStyle = emotionStyle(entry.primaryEmotion)
                  const durationLabel = entry.messageDurationSec != null ? `${Math.round(entry.messageDurationSec)}s` : null
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setSelectedId(entry.id)}
                      className={`w-full rounded-[22px] border px-3 py-3 text-left transition ${
                        active
                          ? 'border-[#75f0df]/40 bg-[#0c8a6d]/18 shadow-[0_0_0_1px_rgba(116,240,223,0.08)]'
                          : 'border-white/6 bg-white/[0.02] hover:border-white/12 hover:bg-white/[0.04]'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <img src={entry.avatarImage} alt={entry.avatarName} className="h-12 w-12 rounded-2xl object-cover ring-1 ring-white/10" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-3">
                            <p className="truncate text-sm font-semibold text-white">{entry.avatarName}</p>
                            <span className="shrink-0 text-[11px] text-white/42">{new Date(entry.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                          </div>
                          <p className="mt-1 text-xs text-[#86f5e5]">{entry.contactName} · {entry.language}</p>
                          <div className="mt-2 flex items-center justify-between gap-3">
                            <span className={`rounded-full border px-2.5 py-1 text-[11px] ${primaryEmotionStyle.border} ${primaryEmotionStyle.bg} ${primaryEmotionStyle.color}`}>
                              {primaryEmotionStyle.emoji} {entry.primaryEmotion}
                            </span>
                            {durationLabel ? (
                              <span className="shrink-0 text-sm font-semibold tracking-[-0.02em] text-white/88">{durationLabel}</span>
                            ) : null}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                            {entry.firedRules.map((rule) => {
                              const style = ruleStyle(rule.rawName)
                              return (
                                <span key={`${entry.id}-${rule.rawName}`} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${style.border} ${style.bg} ${style.color}`}>
                                  <span>{rule.name}</span>
                                  {rule.confidence != null ? (
                                    <span className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full border px-1 text-[10px] font-semibold ${style.border}`}>
                                      {Math.round(rule.confidence * 100)}%
                                    </span>
                                  ) : null}
                                </span>
                              )
                            })}
                          </div>
                          <p className="mt-2 line-clamp-3 text-[13px] leading-6 text-white/62">{entry.transcript || 'No transcript available.'}</p>
                        </div>
                      </div>
                    </button>
                  )
                })}
                {filteredEntries.length === 0 ? (
                  <div className="rounded-[24px] border border-white/8 bg-white/[0.02] px-4 py-5 text-sm text-white/55">
                    No perception logs match the current filters.
                  </div>
                ) : null}
              </div>
            </aside>

            <main className="min-w-0 min-h-0 overflow-y-auto pr-1">
              {selectedEntry ? (
                <div className="space-y-5">
                  <section className="rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(8,18,28,0.94),rgba(4,10,18,0.98))] p-5 shadow-[0_30px_100px_rgba(0,0,0,0.32)] sm:p-6">
                    <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                      <div className="flex items-center gap-4">
                        <img src={selectedEntry.avatarImage} alt={selectedEntry.avatarName} className="h-16 w-16 rounded-[24px] object-cover ring-1 ring-white/10" />
                        <div>
                          <p className="text-[11px] uppercase tracking-[0.24em] text-white/35">Selected Log</p>
                          <h2 className="mt-1 text-2xl font-semibold tracking-[-0.03em] text-white">{selectedEntry.avatarName}</h2>
                          <p className="mt-1 text-sm text-white/58">{selectedEntry.contactName} · {new Date(selectedEntry.createdAt).toLocaleString()}</p>
                        </div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-3">
                        {[
                          { label: 'Primary Emotion', value: selectedEntry.primaryEmotion, style: emotionStyle(selectedEntry.primaryEmotion) },
                          { label: 'Secondary Emotion', value: selectedEntry.secondaryEmotion, style: emotionStyle(selectedEntry.secondaryEmotion) },
                          { label: 'Recommended Tone', value: selectedEntry.recommendedTone, tone: 'from-[#153428] to-[#0b1712]' },
                        ].map((card) => (
                          <div key={card.label} className={`min-w-[160px] rounded-[22px] border px-4 py-4 ${isEmotionCard(card) ? `${card.style.border} ${card.style.bg}` : 'border-white/8 bg-[linear-gradient(180deg,#153428,#0b1712)]'}`}>
                            <div className="text-[11px] uppercase tracking-[0.22em] text-white/42">{card.label}</div>
                            <div className={`mt-3 text-lg font-semibold ${isEmotionCard(card) ? card.style.color : 'text-white'}`}>
                              {isEmotionCard(card) ? `${card.style.emoji} ` : ''}{card.value}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {selectedEntry.messageAudioUrl ? (
                      <div className="mt-5 rounded-[24px] border border-white/8 bg-black/20 p-4">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <p className="text-sm font-medium text-white">Audio playback</p>
                          <p className="text-xs text-white/45">{selectedEntry.messageDurationSec ? formatDuration(selectedEntry.messageDurationSec) : 'Duration unavailable'}</p>
                        </div>
                        <audio src={selectedEntry.messageAudioUrl} controls className="w-full" />
                      </div>
                    ) : null}
                  </section>

                  <section className="grid gap-5 lg:grid-cols-2">
                    <div className="rounded-[28px] border border-emerald-400/18 bg-[linear-gradient(180deg,rgba(10,54,39,0.88),rgba(6,23,18,0.96))] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.25)]">
                      <div className="text-[11px] uppercase tracking-[0.24em] text-emerald-100/50">LUCID Behavioral Summary</div>
                      <p className="mt-4 whitespace-pre-wrap text-[15px] leading-7 text-emerald-50/92">
                        {selectedEntry.behavioralSummary || 'No behavioral summary recorded for this log.'}
                      </p>
                    </div>

                    <div className="rounded-[28px] border border-cyan-400/16 bg-[linear-gradient(180deg,rgba(8,51,66,0.86),rgba(5,18,24,0.96))] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.25)]">
                      <div className="text-[11px] uppercase tracking-[0.24em] text-cyan-100/50">Conversation Hooks</div>
                      <div className="mt-4 space-y-3">
                        {selectedEntry.conversationHooks.length > 0 ? (
                          selectedEntry.conversationHooks.map((hook) => (
                            <div key={hook} className="rounded-[18px] border border-white/8 bg-white/[0.04] px-4 py-3 text-[14px] leading-6 text-cyan-50/90">
                              {hook}
                            </div>
                          ))
                        ) : (
                          <p className="text-[14px] leading-6 text-cyan-50/70">No conversation hooks extracted for this log.</p>
                        )}
                      </div>
                    </div>
                  </section>

                  <section className="rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(8,18,28,0.94),rgba(4,10,18,0.98))] p-5 shadow-[0_30px_90px_rgba(0,0,0,0.28)]">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-[11px] uppercase tracking-[0.24em] text-white/35">ORACLE Pulse</div>
                        <h3 className="mt-2 text-xl font-semibold tracking-[-0.03em] text-white">Fired Rules</h3>
                      </div>
                      <div className="text-sm text-white/48">{selectedEntry.firedRules.length} rules detected</div>
                    </div>
                    <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {selectedEntry.firedRules.length > 0 ? (
                        selectedEntry.firedRules.map((rule) => (
                          <div key={`${rule.rawName}-${rule.category}`} className={`rounded-[20px] border px-4 py-4 ${ruleStyle(rule.rawName).border} ${ruleStyle(rule.rawName).bg}`}>
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <p className={`text-sm font-semibold ${ruleStyle(rule.rawName).color}`}>{rule.name}</p>
                                <p className="mt-1 text-xs uppercase tracking-[0.18em] text-white/38">{rule.category || 'Uncategorized'}</p>
                              </div>
                              <div className={`flex h-9 w-9 items-center justify-center rounded-full border text-xs font-semibold ${ruleStyle(rule.rawName).border} ${ruleStyle(rule.rawName).bg} ${ruleStyle(rule.rawName).color}`}>
                                {rule.confidence != null ? `${Math.round(rule.confidence * 100)}` : '—'}
                              </div>
                            </div>
                            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/8">
                              <div className="h-full rounded-full bg-[linear-gradient(90deg,#4dd7ff,#7af0df)]" style={{ width: `${Math.max(8, Math.round((rule.confidence ?? 0.15) * 100))}%` }} />
                            </div>
                          </div>
                        ))
                      ) : (
                        <p className="text-sm text-white/55">No rules recorded for this perception event.</p>
                      )}
                    </div>
                  </section>

                  <section className="rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(8,18,28,0.94),rgba(4,10,18,0.98))] p-5 shadow-[0_30px_90px_rgba(0,0,0,0.28)]">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-[11px] uppercase tracking-[0.24em] text-white/35">ECHO Prosodic Analysis</div>
                      </div>
                      <div className="text-sm text-white/45">Reference bands shown below each metric</div>
                    </div>

                    <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {METRIC_CONFIG.map((metric) => (
                        <div key={metric.key} className="rounded-[20px] border border-white/8 bg-white/[0.03] px-4 py-4">
                          <div className="text-[11px] uppercase tracking-[0.18em] text-white/35">{metric.label}</div>
                          <div className={`mt-3 text-2xl font-semibold tracking-[-0.03em] ${metric.accent}`}>
                            {formatMetric(metricValue(selectedEntry, metric), metric.unit)}
                          </div>
                          <div className="mt-2 text-xs text-white/42">Reference: {metric.reference}</div>
                        </div>
                      ))}
                    </div>

                    <div className="mt-5 rounded-[22px] border border-white/8 bg-white/[0.03] px-4 py-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.18em] text-white/35">Pause Distribution</div>
                          <div className="mt-2 text-lg font-semibold text-white">
                            {formatMetric(metricValue(selectedEntry, METRIC_CONFIG[6]), '%')}
                          </div>
                        </div>
                        <div className="text-xs text-white/45">Target speech ratio 0.55-0.85</div>
                      </div>
                      <div className="mt-4 h-3 overflow-hidden rounded-full bg-white/8">
                        <div
                          className="h-full rounded-full bg-[linear-gradient(90deg,#74f0df,#4dd7ff)]"
                          style={{
                            width: `${Math.max(
                              4,
                              Math.min(
                              100,
                                Math.round(
                                  (metricValue(selectedEntry, METRIC_CONFIG[6]) ?? 0),
                                ),
                              ),
                            )}%`,
                          }}
                        />
                      </div>
                    </div>
                  </section>

                  <section className="rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(8,18,28,0.94),rgba(4,10,18,0.98))] p-5 shadow-[0_30px_90px_rgba(0,0,0,0.28)]">
                    <div className="text-[11px] uppercase tracking-[0.24em] text-white/35">Full Transcript</div>
                    <div className="mt-4 space-y-4 text-[16px] leading-8 text-white/88">
                      {selectedEntry.transcript ? (
                        transcriptParagraphs(selectedEntry.transcript).map((paragraph, index) => (
                          <p key={`${selectedEntry.id}-${index}`}>{paragraph}</p>
                        ))
                      ) : (
                        <p className="text-white/55">No transcript available for this perception log.</p>
                      )}
                    </div>
                  </section>
                </div>
              ) : (
                <div className="rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(8,18,28,0.94),rgba(4,10,18,0.98))] p-8 text-center text-white/58">
                  No perception entries available yet.
                </div>
              )}
            </main>
          </div>
        )}
      </div>
    </div>
  )
}
