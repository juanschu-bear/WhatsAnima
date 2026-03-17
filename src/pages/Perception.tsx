import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { resolveAvatarUrl } from '../lib/avatars'
import { supabase } from '../lib/supabase'

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
  firedRules: Array<{ name: string; confidence: number | null; category: string | null }>
  prosodicSummary: Record<string, unknown>
  messageAudioUrl: string | null
  messageDurationSec: number | null
  messageType: string | null
}

const LANGUAGE_OPTIONS: LanguageFilter[] = ['All', 'English', 'German', 'Spanish']

const METRIC_CONFIG = [
  { key: 'mean_pitch', label: 'Mean Pitch', unit: 'Hz', reference: '85-255 Hz' },
  { key: 'pitch_range', label: 'Pitch Range', unit: 'Hz', reference: '50-180 Hz' },
  { key: 'pitch_variability', label: 'Pitch Variability', unit: '', reference: '0.10-0.45' },
  { key: 'speaking_rate', label: 'Speaking Rate', unit: 'wps', reference: '2.0-3.8 wps' },
  { key: 'articulation_rate', label: 'Articulation', unit: 'wps', reference: '2.5-4.8 wps' },
  { key: 'mean_pause_duration', label: 'Pause Length', unit: 's', reference: '0.20-1.20 s' },
  { key: 'volume_mean', label: 'Volume Mean', unit: 'dB', reference: '-32 to -14 dB' },
  { key: 'jitter', label: 'Jitter', unit: '', reference: '0.002-0.020' },
  { key: 'shimmer', label: 'Shimmer', unit: '', reference: '0.010-0.060' },
] as const

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

function normalizeRules(value: unknown): Array<{ name: string; confidence: number | null; category: string | null }> {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string') {
        return { name: titleCase(item), confidence: null, category: null }
      }
      if (!item || typeof item !== 'object') return null
      const obj = item as Record<string, unknown>
      const name = titleCase(
        typeof obj.name === 'string'
          ? obj.name
          : typeof obj.rule === 'string'
            ? obj.rule
            : typeof obj.label === 'string'
              ? obj.label
              : '',
        '',
      )
      if (!name) return null
      return {
        name,
        confidence: toNumber(obj.confidence),
        category: typeof obj.category === 'string' ? titleCase(obj.category) : null,
      }
    })
    .filter((item): item is { name: string; confidence: number | null; category: string | null } => Boolean(item))
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
        const [{ data: owners, error: ownersError }, { data: conversations, error: conversationsError }] = await Promise.all([
          supabase
            .from('wa_owners')
            .select('id, display_name')
            .is('deleted_at', null),
          supabase
            .from('wa_conversations')
            .select('id, owner_id, contact_id, created_at, updated_at'),
        ])

        if (ownersError) throw ownersError
        if (conversationsError) throw conversationsError

        const ownerRows = (owners ?? []) as OwnerRow[]
        const conversationRows = (conversations ?? []) as ConversationRow[]
        const conversationIds = conversationRows.map((conversation) => conversation.id)
        if (conversationIds.length === 0) {
          if (!cancelled) {
            setEntries([])
            setLoading(false)
          }
          return
        }

        const contactIds = Array.from(new Set(conversationRows.map((conversation) => conversation.contact_id)))
        const [{ data: contacts, error: contactsError }, { data: logs, error: logsError }] = await Promise.all([
          supabase
            .from('wa_contacts')
            .select('id, display_name, email')
            .in('id', contactIds),
          supabase
            .from('wa_perception_logs')
            .select(`
              id,
              message_id,
              conversation_id,
              contact_id,
              owner_id,
              transcript,
              primary_emotion,
              secondary_emotion,
              recommended_tone,
              fired_rules,
              behavioral_summary,
              conversation_hooks,
              prosodic_summary,
              audio_duration_sec,
              created_at
            `)
            .order('created_at', { ascending: false }),
        ])

        if (contactsError) throw contactsError
        if (logsError) throw logsError

        const logRows = (logs ?? []) as PerceptionLogRow[]
        const messageIds = Array.from(new Set(logRows.map((log) => log.message_id).filter(Boolean))) as string[]
        const { data: messages, error: messagesError } = messageIds.length === 0
          ? { data: [], error: null }
          : await supabase
              .from('wa_messages')
              .select('id, media_url, duration_sec, type, content, created_at')
              .in('id', messageIds)

        if (messagesError) throw messagesError

        const ownerById = new Map(ownerRows.map((owner) => [owner.id, owner]))
        const contactById = new Map(((contacts ?? []) as ContactRow[]).map((contact) => [contact.id, contact]))
        const conversationById = new Map(conversationRows.map((conversation) => [conversation.id, conversation]))
        const messageById = new Map(((messages ?? []) as MessageRow[]).map((message) => [message.id, message]))

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
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(0,195,170,0.12),transparent_30%),radial-gradient(circle_at_82%_18%,rgba(72,137,255,0.12),transparent_24%),linear-gradient(180deg,#04101a_0%,#07111b_55%,#02060b_100%)] text-white">
      <div className="mx-auto max-w-[1560px] px-4 py-6 sm:px-6 lg:px-8">
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
          <div className="flex min-h-[420px] items-center justify-center">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/10 border-t-[#7cf0e1]" />
          </div>
        ) : error ? (
          <div className="mt-6 rounded-[28px] border border-rose-400/20 bg-rose-500/10 p-6 text-sm text-rose-100">
            {error}
          </div>
        ) : (
          <div className="mt-6 grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
            <aside className="rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(8,18,28,0.92),rgba(5,11,18,0.96))] p-3 shadow-[0_30px_90px_rgba(0,0,0,0.3)]">
              <div className="flex items-center justify-between px-2 pb-3 pt-1">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.25em] text-white/35">Timeline</p>
                  <p className="mt-1 text-sm text-white/58">{filteredEntries.length} filtered logs</p>
                </div>
              </div>

              <div className="space-y-2">
                {filteredEntries.map((entry) => {
                  const active = entry.id === selectedEntry?.id
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
                          <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                            <span className="rounded-full border border-white/8 bg-white/6 px-2.5 py-1 text-white/70">{entry.primaryEmotion}</span>
                            {entry.firedRules[0] ? (
                              <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 text-cyan-100">{entry.firedRules[0].name}</span>
                            ) : null}
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

            <main className="min-w-0 space-y-5">
              {selectedEntry ? (
                <>
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
                          { label: 'Primary Emotion', value: selectedEntry.primaryEmotion, tone: 'from-[#1b2d47] to-[#0e1826]' },
                          { label: 'Secondary Emotion', value: selectedEntry.secondaryEmotion, tone: 'from-[#2e2242] to-[#14101c]' },
                          { label: 'Recommended Tone', value: selectedEntry.recommendedTone, tone: 'from-[#153428] to-[#0b1712]' },
                        ].map((card) => (
                          <div key={card.label} className={`min-w-[160px] rounded-[22px] border border-white/8 bg-[linear-gradient(180deg,${card.tone})] px-4 py-4`}>
                            <div className="text-[11px] uppercase tracking-[0.22em] text-white/42">{card.label}</div>
                            <div className="mt-3 text-lg font-semibold text-white">{card.value}</div>
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
                          <div key={`${rule.name}-${rule.category}`} className="rounded-[20px] border border-white/8 bg-white/[0.03] px-4 py-4">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <p className="text-sm font-semibold text-white">{rule.name}</p>
                                <p className="mt-1 text-xs uppercase tracking-[0.18em] text-white/38">{rule.category || 'Uncategorized'}</p>
                              </div>
                              <div className="rounded-full border border-white/8 bg-white/6 px-2.5 py-1 text-xs text-white/72">
                                {rule.confidence != null ? `${Math.round(rule.confidence * 100)}%` : '—'}
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
                        <h3 className="mt-2 text-xl font-semibold tracking-[-0.03em] text-white">3 × 3 metric grid</h3>
                      </div>
                      <div className="text-sm text-white/45">Reference bands shown below each metric</div>
                    </div>

                    <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {METRIC_CONFIG.map((metric) => (
                        <div key={metric.key} className="rounded-[20px] border border-white/8 bg-white/[0.03] px-4 py-4">
                          <div className="text-[11px] uppercase tracking-[0.18em] text-white/35">{metric.label}</div>
                          <div className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-white">
                            {formatMetric(selectedEntry.prosodicSummary[metric.key], metric.unit)}
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
                            {formatMetric(selectedEntry.prosodicSummary.pause_ratio ?? selectedEntry.prosodicSummary.speech_ratio, '')}
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
                                  ((toNumber(selectedEntry.prosodicSummary.pause_ratio ?? selectedEntry.prosodicSummary.speech_ratio) ?? 0) * 100),
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
                </>
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
