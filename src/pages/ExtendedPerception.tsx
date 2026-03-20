import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { resolveAvatarUrl } from '../lib/avatars'

type MediaFilter = 'all' | 'audio' | 'video' | 'text'
type TimeWindow = '24h' | '7d' | '30d' | 'all'

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
}

interface MessageRow {
  id: string
  media_url: string | null
  duration_sec: number | null
  type: string | null
  content: string | null
}

interface PerceptionLogRow {
  id: string
  message_id: string | null
  conversation_id: string
  transcript: string | null
  behavioral_summary: string | null
  prosodic_summary: Record<string, unknown> | null
  facial_analysis: Record<string, unknown> | null
  body_language: Record<string, unknown> | null
  media_type: string | null
  audio_duration_sec: number | null
  video_duration_sec: number | null
  created_at: string
}

interface PerceptionDashboardPayload {
  owners: OwnerRow[]
  contacts: ContactRow[]
  conversations: ConversationRow[]
  messages: MessageRow[]
  logs: PerceptionLogRow[]
}

interface SignalEntry {
  id: string
  createdAt: string
  createdAtMs: number
  avatarName: string
  avatarImage: string
  contactName: string
  transcript: string
  behavioralSummary: string
  prosodicSummary: Record<string, unknown>
  facialAnalysis: Record<string, unknown>
  bodyLanguage: Record<string, unknown>
  mediaType: MediaFilter
  mediaUrl: string | null
  durationSec: number
  vocalWarmth: number
  facialTension: number
  physioArousal: number
  gestureLoad: number
  incongruence: boolean
  incongruenceScore: number
  incongruenceReason: string
}

interface EngineNode {
  key: string
  label: string
  value: number
  accent: string
  x: number
  y: number
}

const timeWindowCutoffMs: Record<Exclude<TimeWindow, 'all'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function normalizePercentLike(value: number | null, fallback = 50): number {
  if (value == null) return fallback
  if (value <= 1) return clamp(value * 100, 0, 100)
  return clamp(value, 0, 100)
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = toNumber(source[key])
    if (value != null) return value
  }
  return null
}

function normalizeBodySummary(source: Record<string, unknown>): string {
  if (typeof source.summary === 'string' && source.summary.trim()) return source.summary.trim()
  const parts = [source.posture_summary, source.hand_gesture_summary, source.movement_summary]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
  return parts.join(' • ')
}

function computeVocalWarmth(prosody: Record<string, unknown>): number {
  const stability = normalizePercentLike(firstNumber(prosody, ['voice_stability', 'harmonic_to_noise_ratio']), 58) / 100
  const tremor = normalizePercentLike(firstNumber(prosody, ['voice_tremor', 'jitter', 'shimmer']), 20) / 100
  const pace = firstNumber(prosody, ['speaking_rate_wps', 'speaking_rate'])
  const pauseMs = firstNumber(prosody, ['average_pause_ms', 'mean_pause_duration'])
  const volume = firstNumber(prosody, ['mean_volume_db', 'volume_mean'])

  const paceScore = pace != null ? clamp(1 - Math.abs(pace - 2) / 2, 0, 1) : 0.55
  const pauseScore = pauseMs != null ? clamp(1 - pauseMs / 2400, 0, 1) : 0.52
  const volumeScore = volume != null ? clamp((volume + 54) / 26, 0, 1) : 0.5

  const total = stability * 0.36 + (1 - tremor) * 0.24 + paceScore * 0.18 + pauseScore * 0.12 + volumeScore * 0.1
  return Math.round(clamp(total * 100, 0, 100))
}

function readActionUnits(facial: Record<string, unknown>): Record<string, number> {
  const source = (facial.au_averages || facial.action_units || facial.au_scores || {}) as Record<string, unknown>
  const mapped: Record<string, number> = {}
  for (const [key, raw] of Object.entries(source)) {
    const value = toNumber(raw)
    if (value == null) continue
    const normalized = value <= 1 ? value : value / 100
    mapped[key.toLowerCase().replace(/[^a-z0-9]/g, '')] = clamp(normalized, 0, 1)
  }
  return mapped
}

function readEmotionMap(facial: Record<string, unknown>): Record<string, number> {
  const source = (
    facial.emotion_profile ||
    facial.emotion_percentages ||
    facial.emotions ||
    facial.emotion_distribution ||
    {}
  ) as Record<string, unknown>

  const mapped: Record<string, number> = {}
  for (const [key, raw] of Object.entries(source)) {
    const value = toNumber(raw)
    if (value == null) continue
    mapped[key.toLowerCase()] = clamp(value <= 1 ? value : value / 100, 0, 1)
  }
  return mapped
}

function computePhysioArousal(prosody: Record<string, unknown>, body: Record<string, unknown>): number {
  const volume = firstNumber(prosody, ['mean_volume_db', 'volume_mean'])
  const pace = firstNumber(prosody, ['speaking_rate_wps', 'speaking_rate'])
  const bodyIntensity = firstNumber(body, ['movement_intensity', 'gesture_intensity', 'posture_tension'])
  const summary = normalizeBodySummary(body).toLowerCase()

  const volumeScore = volume != null ? clamp((volume + 60) / 30, 0, 1) : 0.5
  const paceScore = pace != null ? clamp(pace / 3.4, 0, 1) : 0.5
  const bodyScore = normalizePercentLike(bodyIntensity, 46) / 100

  let lexicalBoost = 0
  if (/(tense|rigid|restless|fidget|agitated|rapid)/.test(summary)) lexicalBoost += 0.12
  if (/(calm|steady|relaxed|open)/.test(summary)) lexicalBoost -= 0.08

  const total = clamp(volumeScore * 0.34 + paceScore * 0.24 + bodyScore * 0.42 + lexicalBoost, 0, 1)
  return Math.round(total * 100)
}

function computeGestureLoad(body: Record<string, unknown>): number {
  const gestureValue = firstNumber(body, ['gesture_intensity', 'hand_gesture_intensity', 'gesture_load'])
  if (gestureValue != null) return Math.round(normalizePercentLike(gestureValue, 44))

  const summary = normalizeBodySummary(body).toLowerCase()
  if (!summary) return 44
  let score = 44
  if (/(hand|gesture|movement|animated|expressive)/.test(summary)) score += 18
  if (/(still|minimal|contained|controlled)/.test(summary)) score -= 12
  return Math.round(clamp(score, 0, 100))
}

function computeFacialTension(facial: Record<string, unknown>, body: Record<string, unknown>): number {
  const aus = readActionUnits(facial)
  const emotions = readEmotionMap(facial)

  const auScore =
    (aus.au4 ?? 0) * 0.30 +
    (aus.au7 ?? 0) * 0.18 +
    (aus.au17 ?? 0) * 0.15 +
    (aus.au23 ?? 0) * 0.18 +
    (aus.au24 ?? 0) * 0.19

  const emotionScore =
    (emotions.anger ?? 0) * 0.44 +
    (emotions.fear ?? 0) * 0.22 +
    (emotions.disgust ?? 0) * 0.14 +
    (emotions.sadness ?? 0) * 0.10 +
    (emotions.surprise ?? 0) * 0.10

  const bodyActivation = computePhysioArousal({}, body) / 100
  const total = auScore * 0.56 + emotionScore * 0.30 + bodyActivation * 0.14
  return Math.round(clamp(total * 100, 0, 100))
}

function detectIncongruence(vocalWarmth: number, facialTension: number, physioArousal: number): { flag: boolean; score: number; reason: string } {
  const warmthNorm = vocalWarmth / 100
  const tensionNorm = facialTension / 100
  const physioNorm = physioArousal / 100

  const contradictionStrength = warmthNorm * 0.44 + tensionNorm * 0.44 + physioNorm * 0.12
  const score = Math.round(clamp(contradictionStrength * 100, 0, 100))
  const flag = vocalWarmth >= 66 && facialTension >= 60
  const reason = flag
    ? `Vocal warmth ${vocalWarmth}% conflicts with facial tension ${facialTension}% while physiologic arousal is ${physioArousal}%.`
    : 'Signals are not strongly contradictory in this window.'

  return { flag, score, reason }
}

function formatClock(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function linePath(values: number[], width: number, height: number): string {
  if (values.length === 0) return ''
  const stepX = values.length > 1 ? width / (values.length - 1) : 0
  return values
    .map((value, index) => {
      const x = index * stepX
      const y = height - clamp(value, 0, 100) / 100 * height
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(' ')
}

function correlation(valuesA: number[], valuesB: number[]): number {
  if (valuesA.length < 2 || valuesA.length !== valuesB.length) return 0
  const meanA = valuesA.reduce((sum, value) => sum + value, 0) / valuesA.length
  const meanB = valuesB.reduce((sum, value) => sum + value, 0) / valuesB.length

  let numerator = 0
  let denA = 0
  let denB = 0

  for (let index = 0; index < valuesA.length; index += 1) {
    const da = valuesA[index] - meanA
    const db = valuesB[index] - meanB
    numerator += da * db
    denA += da * da
    denB += db * db
  }

  const denominator = Math.sqrt(denA * denB)
  if (!Number.isFinite(denominator) || denominator <= 0) return 0
  return clamp(numerator / denominator, -1, 1)
}

function drawCurve(fromX: number, fromY: number, toX: number, toY: number): string {
  const delta = Math.max(40, Math.abs(toX - fromX) * 0.45)
  return `M ${fromX} ${fromY} C ${fromX + delta} ${fromY}, ${toX - delta} ${toY}, ${toX} ${toY}`
}

function parseMediaType(typeRaw: string): MediaFilter {
  const lowered = typeRaw.toLowerCase()
  if (lowered.includes('video')) return 'video'
  if (lowered.includes('audio') || lowered.includes('voice')) return 'audio'
  return 'text'
}

function deriveSignalEntries(payload: PerceptionDashboardPayload): SignalEntry[] {
  const ownerById = new Map(payload.owners.map((owner) => [owner.id, owner]))
  const contactById = new Map(payload.contacts.map((contact) => [contact.id, contact]))
  const conversationById = new Map(payload.conversations.map((conversation) => [conversation.id, conversation]))
  const messageById = new Map(payload.messages.map((message) => [message.id, message]))

  return (payload.logs || []).map((log) => {
    const conversation = conversationById.get(log.conversation_id)
    const owner = conversation ? ownerById.get(conversation.owner_id) : null
    const contact = conversation ? contactById.get(conversation.contact_id) : null
    const message = log.message_id ? messageById.get(log.message_id) : null

    const avatarName = owner?.display_name?.trim() || 'Avatar'
    const transcript = (log.transcript || message?.content || '').trim()
    const behavioralSummary = (log.behavioral_summary || '').trim()
    const prosodicSummary = log.prosodic_summary ?? {}
    const facialAnalysis = log.facial_analysis ?? {}
    const bodyLanguage = log.body_language ?? {}
    const mediaType = parseMediaType(log.media_type || message?.type || 'text')
    const durationSec = log.video_duration_sec ?? log.audio_duration_sec ?? message?.duration_sec ?? 0

    const vocalWarmth = computeVocalWarmth(prosodicSummary)
    const physioArousal = computePhysioArousal(prosodicSummary, bodyLanguage)
    const facialTension = computeFacialTension(facialAnalysis, bodyLanguage)
    const gestureLoad = computeGestureLoad(bodyLanguage)

    const detection = detectIncongruence(vocalWarmth, facialTension, physioArousal)

    return {
      id: log.id,
      createdAt: log.created_at,
      createdAtMs: new Date(log.created_at).getTime(),
      avatarName,
      avatarImage: resolveAvatarUrl(avatarName),
      contactName: contact?.display_name?.trim() || contact?.email?.trim() || 'Guest',
      transcript,
      behavioralSummary,
      prosodicSummary,
      facialAnalysis,
      bodyLanguage,
      mediaType,
      mediaUrl: message?.media_url ?? null,
      durationSec,
      vocalWarmth,
      facialTension,
      physioArousal,
      gestureLoad,
      incongruence: detection.flag,
      incongruenceScore: detection.score,
      incongruenceReason: detection.reason,
    }
  })
}

export default function ExtendedPerception() {
  const navigate = useNavigate()
  const { user } = useAuth()

  const [entries, setEntries] = useState<SignalEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [avatarFilter, setAvatarFilter] = useState('All')
  const [contactFilter, setContactFilter] = useState('All')
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all')
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('7d')
  const [searchText, setSearchText] = useState('')
  const [incongruenceOnly, setIncongruenceOnly] = useState(false)

  const [selectedId, setSelectedId] = useState<string | null>(null)

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
        const payload = (await response.json()) as PerceptionDashboardPayload & { error?: string }
        if (!response.ok) {
          throw new Error(payload.error || `Failed to load perception dashboard (${response.status})`)
        }

        const nextEntries = deriveSignalEntries(payload)
          .sort((left, right) => right.createdAtMs - left.createdAtMs)
          .slice(0, 250)

        if (!cancelled) {
          setEntries(nextEntries)
          setSelectedId(nextEntries[0]?.id ?? null)
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load extended perception dashboard.')
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

  const contactOptions = useMemo(
    () => ['All', ...Array.from(new Set(entries.map((entry) => entry.contactName))).sort()],
    [entries],
  )

  const filteredEntries = useMemo(() => {
    const now = Date.now()
    const normalizedQuery = searchText.trim().toLowerCase()

    return entries.filter((entry) => {
      if (avatarFilter !== 'All' && entry.avatarName !== avatarFilter) return false
      if (contactFilter !== 'All' && entry.contactName !== contactFilter) return false
      if (mediaFilter !== 'all' && entry.mediaType !== mediaFilter) return false
      if (incongruenceOnly && !entry.incongruence) return false

      if (timeWindow !== 'all') {
        const delta = now - entry.createdAtMs
        if (delta > timeWindowCutoffMs[timeWindow]) return false
      }

      if (!normalizedQuery) return true
      const haystack = [entry.avatarName, entry.contactName, entry.transcript, entry.behavioralSummary]
        .join(' ')
        .toLowerCase()
      return haystack.includes(normalizedQuery)
    })
  }, [avatarFilter, contactFilter, entries, incongruenceOnly, mediaFilter, searchText, timeWindow])

  useEffect(() => {
    if (filteredEntries.length === 0) {
      setSelectedId(null)
      return
    }
    if (!selectedId || !filteredEntries.some((entry) => entry.id === selectedId)) {
      setSelectedId(filteredEntries[0].id)
    }
  }, [filteredEntries, selectedId])

  const selected = useMemo(
    () => filteredEntries.find((entry) => entry.id === selectedId) ?? filteredEntries[0] ?? null,
    [filteredEntries, selectedId],
  )

  const chronologicalSeries = useMemo(
    () => [...filteredEntries].sort((left, right) => left.createdAtMs - right.createdAtMs).slice(-36),
    [filteredEntries],
  )

  const warmthSeries = useMemo(() => chronologicalSeries.map((entry) => entry.vocalWarmth), [chronologicalSeries])
  const facialSeries = useMemo(() => chronologicalSeries.map((entry) => entry.facialTension), [chronologicalSeries])
  const physioSeries = useMemo(() => chronologicalSeries.map((entry) => entry.physioArousal), [chronologicalSeries])

  const corr = useMemo(() => correlation(warmthSeries, facialSeries), [facialSeries, warmthSeries])

  const incongruenceEvents = useMemo(
    () => filteredEntries.filter((entry) => entry.incongruence).slice(0, 8),
    [filteredEntries],
  )

  const engineNodes: EngineNode[] = useMemo(
    () => [
      {
        key: 'auditory',
        label: 'Auditory · Warmth',
        value: selected?.vocalWarmth ?? 0,
        accent: 'from-emerald-300 to-lime-300',
        x: 120,
        y: 86,
      },
      {
        key: 'facial',
        label: 'Facial · Tension',
        value: selected?.facialTension ?? 0,
        accent: 'from-rose-300 to-red-400',
        x: 120,
        y: 178,
      },
      {
        key: 'physio',
        label: 'Physio · Arousal',
        value: selected?.physioArousal ?? 0,
        accent: 'from-amber-300 to-yellow-300',
        x: 120,
        y: 270,
      },
      {
        key: 'gesture',
        label: 'Gesture · Load',
        value: selected?.gestureLoad ?? 0,
        accent: 'from-cyan-300 to-sky-300',
        x: 120,
        y: 362,
      },
    ],
    [selected],
  )

  const strongFlag = selected?.incongruence ?? false

  return (
    <div className="min-h-[100dvh] bg-[radial-gradient(circle_at_18%_0%,rgba(29,197,255,0.16),transparent_32%),radial-gradient(circle_at_96%_12%,rgba(34,213,188,0.15),transparent_24%),linear-gradient(180deg,#02070f_0%,#030b16_48%,#05101d_100%)] text-white">
      <div
        className="mx-auto w-full max-w-[1680px] px-4 sm:px-6 lg:px-8"
        style={{
          paddingTop: 'max(1.1rem, env(safe-area-inset-top))',
          paddingBottom: 'max(1.4rem, env(safe-area-inset-bottom))',
        }}
      >
        <header className="rounded-[30px] border border-cyan-300/24 bg-[linear-gradient(180deg,rgba(7,18,34,0.96),rgba(4,10,20,0.98))] p-5 shadow-[0_38px_130px_rgba(0,0,0,0.45)] sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div>
              <p className="text-[11px] uppercase tracking-[0.34em] text-cyan-100/65">Extended Perception Dashboard</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-white sm:text-4xl">ORACLE: Crossmodal Pattern Recognition</h1>
              <p className="mt-2 max-w-4xl text-sm text-white/64 sm:text-[15px]">
                Signal-comparison and incongruence diagnostics between vocal prosody, facial Action Units, body language, and temporal alignment.
              </p>
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => navigate('/perception')}
                className="rounded-2xl border border-white/14 bg-white/[0.06] px-4 py-2.5 text-sm text-white/80 transition hover:bg-white/[0.1]"
              >
                Perception
              </button>
              <button
                type="button"
                onClick={() => navigate('/')}
                className="rounded-2xl border border-cyan-300/30 bg-cyan-400/15 px-4 py-2.5 text-sm text-cyan-100 transition hover:border-cyan-200/70 hover:text-white"
              >
                Home
              </button>
            </div>
          </div>

          <div className="mt-5 grid gap-3 lg:grid-cols-6">
            <label className="flex flex-col gap-2 text-[11px] uppercase tracking-[0.18em] text-white/45">
              Avatar
              <select value={avatarFilter} onChange={(event) => setAvatarFilter(event.target.value)} className="rounded-2xl border border-white/14 bg-[#091322] px-3 py-2.5 text-sm tracking-normal text-white outline-none transition focus:border-cyan-300/60">
                {avatarOptions.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-2 text-[11px] uppercase tracking-[0.18em] text-white/45">
              User / Contact
              <select value={contactFilter} onChange={(event) => setContactFilter(event.target.value)} className="rounded-2xl border border-white/14 bg-[#091322] px-3 py-2.5 text-sm tracking-normal text-white outline-none transition focus:border-cyan-300/60">
                {contactOptions.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-2 text-[11px] uppercase tracking-[0.18em] text-white/45">
              Media
              <select value={mediaFilter} onChange={(event) => setMediaFilter(event.target.value as MediaFilter)} className="rounded-2xl border border-white/14 bg-[#091322] px-3 py-2.5 text-sm tracking-normal text-white outline-none transition focus:border-cyan-300/60">
                <option value="all">All</option>
                <option value="audio">Audio</option>
                <option value="video">Video</option>
                <option value="text">Text</option>
              </select>
            </label>
            <label className="flex flex-col gap-2 text-[11px] uppercase tracking-[0.18em] text-white/45">
              Time Window
              <select value={timeWindow} onChange={(event) => setTimeWindow(event.target.value as TimeWindow)} className="rounded-2xl border border-white/14 bg-[#091322] px-3 py-2.5 text-sm tracking-normal text-white outline-none transition focus:border-cyan-300/60">
                <option value="24h">Last 24h</option>
                <option value="7d">Last 7d</option>
                <option value="30d">Last 30d</option>
                <option value="all">All</option>
              </select>
            </label>
            <label className="flex flex-col gap-2 text-[11px] uppercase tracking-[0.18em] text-white/45 lg:col-span-2">
              Search
              <input
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="Search transcript, summary, name..."
                className="rounded-2xl border border-white/14 bg-[#091322] px-3 py-2.5 text-sm text-white placeholder:text-white/35 outline-none transition focus:border-cyan-300/60"
              />
            </label>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => setIncongruenceOnly((current) => !current)}
              className={`rounded-full border px-3 py-1.5 text-xs transition ${incongruenceOnly ? 'border-rose-300/55 bg-rose-500/20 text-rose-100' : 'border-white/14 bg-white/[0.05] text-white/70 hover:bg-white/[0.08]'}`}
            >
              {incongruenceOnly ? 'Incongruence Only: ON' : 'Incongruence Only'}
            </button>
            <span className="rounded-full border border-cyan-300/30 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-100/90">
              Filtered logs: {filteredEntries.length}
            </span>
          </div>
        </header>

        {loading ? (
          <div className="flex min-h-[38vh] items-center justify-center">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/10 border-t-cyan-300" />
          </div>
        ) : error ? (
          <div className="mt-6 rounded-[24px] border border-rose-400/30 bg-rose-500/10 p-5 text-sm text-rose-100">{error}</div>
        ) : filteredEntries.length === 0 ? (
          <div className="mt-6 rounded-[24px] border border-white/12 bg-white/[0.03] p-6 text-sm text-white/68">
            No matching entries for the current filters.
          </div>
        ) : (
          <div className="mt-6 grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
            <aside className="rounded-[26px] border border-cyan-300/14 bg-[linear-gradient(180deg,rgba(6,14,26,0.94),rgba(3,8,16,0.98))] p-3 shadow-[0_34px_90px_rgba(0,0,0,0.4)] xl:max-h-[calc(100vh-210px)] xl:overflow-y-auto">
              <div className="px-2 pb-3 pt-1">
                <p className="text-[11px] uppercase tracking-[0.24em] text-cyan-100/45">Signal Feed</p>
                <p className="mt-1 text-xs text-white/52">newest → oldest</p>
              </div>
              <div className="space-y-2">
                {filteredEntries.map((entry) => {
                  const active = selected?.id === entry.id
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setSelectedId(entry.id)}
                      className={`w-full rounded-[20px] border px-3 py-3 text-left transition ${
                        active
                          ? 'border-cyan-300/55 bg-cyan-400/14 shadow-[0_0_0_1px_rgba(74,222,255,0.15)]'
                          : 'border-white/8 bg-white/[0.03] hover:border-cyan-300/28 hover:bg-white/[0.06]'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <img src={entry.avatarImage} alt={entry.avatarName} className="h-11 w-11 rounded-xl object-cover ring-1 ring-white/10" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <p className="truncate text-sm font-medium text-white">{entry.avatarName}</p>
                            <span className="text-[10px] text-white/45">{formatClock(entry.createdAt)}</span>
                          </div>
                          <p className="mt-1 truncate text-xs text-cyan-100/72">{entry.contactName}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
                            <span className="rounded-full border border-emerald-300/35 bg-emerald-400/12 px-2 py-0.5 text-emerald-100">Warmth {entry.vocalWarmth}%</span>
                            <span className="rounded-full border border-rose-300/35 bg-rose-400/12 px-2 py-0.5 text-rose-100">Tension {entry.facialTension}%</span>
                            {entry.incongruence ? (
                              <span className="rounded-full border border-rose-200/55 bg-rose-500/25 px-2 py-0.5 text-rose-50">INCONGRUENCE</span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </aside>

            {selected ? (
              <main className="space-y-5">
                <section className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
                  <article className="rounded-[26px] border border-cyan-300/22 bg-[linear-gradient(180deg,rgba(8,18,33,0.95),rgba(4,10,19,0.98))] p-4 shadow-[0_24px_90px_rgba(0,0,0,0.35)]">
                    <div className="flex items-center gap-3">
                      <img src={selected.avatarImage} alt={selected.avatarName} className="h-14 w-14 rounded-2xl object-cover ring-1 ring-white/12" />
                      <div>
                        <p className="text-sm font-semibold text-white">{selected.avatarName}</p>
                        <p className="text-xs text-cyan-100/75">{selected.contactName}</p>
                      </div>
                    </div>
                    <div className="mt-3 rounded-2xl border border-white/10 bg-black/25 p-3">
                      <p className="text-[11px] uppercase tracking-[0.16em] text-white/45">Media</p>
                      {selected.mediaUrl ? (
                        selected.mediaType === 'video' ? (
                          <video src={selected.mediaUrl} controls playsInline className="mt-2 h-[200px] w-full rounded-xl bg-black object-cover" />
                        ) : selected.mediaType === 'audio' ? (
                          <audio controls src={selected.mediaUrl} className="mt-2 w-full" />
                        ) : (
                          <div className="mt-2 rounded-xl border border-white/10 bg-[#070d16] p-3 text-xs text-white/65">Text-only signal (no media file)</div>
                        )
                      ) : (
                        <div className="mt-2 rounded-xl border border-white/10 bg-[#070d16] p-3 text-xs text-white/65">No media available</div>
                      )}
                    </div>
                    <p className="mt-3 text-xs text-white/52">{new Date(selected.createdAt).toLocaleString()} • {selected.mediaType.toUpperCase()} • {Math.round(selected.durationSec)}s</p>
                  </article>

                  <article className="rounded-[26px] border border-cyan-300/24 bg-[linear-gradient(180deg,rgba(8,18,33,0.96),rgba(4,10,20,0.98))] p-5 shadow-[0_24px_90px_rgba(0,0,0,0.35)]">
                    <div className="grid gap-4 lg:grid-cols-2">
                      <div>
                        <p className="text-[11px] uppercase tracking-[0.22em] text-cyan-100/58">Signal Comparison</p>
                        <div className="mt-3 grid grid-cols-2 gap-3">
                          {[
                            { label: 'Vocal Warmth', value: selected.vocalWarmth, grad: 'from-emerald-300 via-lime-300 to-yellow-300', text: 'text-emerald-100' },
                            { label: 'Facial Tension', value: selected.facialTension, grad: 'from-rose-300 via-red-400 to-orange-400', text: 'text-rose-100' },
                          ].map((item) => (
                            <div key={item.label} className="rounded-2xl border border-white/10 bg-black/24 p-3">
                              <p className="text-[11px] uppercase tracking-[0.14em] text-white/52">{item.label}</p>
                              <div className="mt-2 h-36 rounded-xl border border-white/10 bg-[#060d16] p-2">
                                <div className="flex h-full flex-col items-center justify-end gap-2">
                                  <div className="relative h-full w-16 overflow-hidden rounded-[10px] border border-white/14 bg-white/5">
                                    <div className={`absolute bottom-0 left-0 w-full rounded-[9px] bg-gradient-to-t ${item.grad} transition-all duration-700`} style={{ height: `${item.value}%` }} />
                                  </div>
                                  <span className={`text-xl font-semibold ${item.text}`}>{item.value}%</span>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div>
                        <p className="text-[11px] uppercase tracking-[0.22em] text-cyan-100/58">Incongruence Detection</p>
                        <div className={`mt-3 rounded-2xl border p-4 ${strongFlag ? 'border-rose-300/50 bg-rose-500/14' : 'border-emerald-300/40 bg-emerald-500/12'}`}>
                          <p className={`text-lg font-semibold ${strongFlag ? 'text-rose-100' : 'text-emerald-100'}`}>
                            {strongFlag ? 'INCONGRUENCE DETECTED' : 'SIGNALS CONGRUENT'}
                          </p>
                          <p className={`mt-1 text-sm ${strongFlag ? 'text-rose-100/80' : 'text-emerald-100/80'}`}>{selected.incongruenceReason}</p>
                          <div className="mt-3 flex items-center justify-between text-sm">
                            <span className="text-white/65">Timestamp</span>
                            <span className="text-white">{new Date(selected.createdAt).toLocaleString()}</span>
                          </div>
                          <div className="mt-2 flex items-center justify-between text-sm">
                            <span className="text-white/65">Rule</span>
                            <span className="text-white">Vocal/Facial Dissonance (14B)</span>
                          </div>
                          <div className="mt-2 flex items-center justify-between text-sm">
                            <span className="text-white/65">Confidence</span>
                            <span className="text-white">{selected.incongruenceScore}%</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </article>
                </section>

                <section className="rounded-[26px] border border-cyan-300/24 bg-[linear-gradient(180deg,rgba(8,18,33,0.96),rgba(4,10,20,0.98))] p-5 shadow-[0_24px_90px_rgba(0,0,0,0.35)]">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-cyan-100/58">ORACLE Crossmodal Engine</p>
                  <div className="mt-3 relative overflow-x-auto">
                    <div className="relative min-w-[860px] rounded-2xl border border-white/10 bg-black/20 p-4">
                      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 900 440" preserveAspectRatio="none" aria-hidden>
                        {engineNodes.map((node) => (
                          <path
                            key={node.key}
                            d={drawCurve(node.x + 160, node.y, 470, 220)}
                            fill="none"
                            stroke={node.key === 'facial' ? '#ff6b8a' : node.key === 'auditory' ? '#7fffb6' : node.key === 'physio' ? '#f6e36e' : '#6be5ff'}
                            strokeWidth="2.5"
                            strokeDasharray="8 8"
                            opacity="0.85"
                          />
                        ))}
                        <path
                          d={drawCurve(590, 220, 760, 220)}
                          fill="none"
                          stroke={strongFlag ? '#ff6b8a' : '#70efad'}
                          strokeWidth="3.3"
                        />
                      </svg>

                      <div className="relative z-10 grid grid-cols-[220px_1fr_260px] gap-5">
                        <div className="space-y-3">
                          {engineNodes.map((node) => (
                            <div key={node.key} className="rounded-xl border border-white/14 bg-[#081222] p-3">
                              <div className="flex items-center justify-between text-xs text-white/62">
                                <span>{node.label}</span>
                                <span>{node.value}%</span>
                              </div>
                              <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                                <div className={`h-full rounded-full bg-gradient-to-r ${node.accent}`} style={{ width: `${node.value}%` }} />
                              </div>
                            </div>
                          ))}
                        </div>

                        <div className="flex items-center justify-center">
                          <div className="w-[230px] rounded-2xl border border-cyan-300/40 bg-cyan-500/12 p-4 text-center shadow-[0_0_0_1px_rgba(77,199,255,0.18)]">
                            <p className="text-sm font-semibold tracking-wide text-cyan-100">ORACLE</p>
                            <p className="text-xs uppercase tracking-[0.17em] text-cyan-100/70">Crossmodal Engine</p>
                            <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-white/75">
                              <div className="rounded-lg border border-white/12 bg-black/20 p-2">
                                Temporal Alignment
                              </div>
                              <div className="rounded-lg border border-white/12 bg-black/20 p-2">
                                Pattern Fusion
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className={`rounded-2xl border p-4 ${strongFlag ? 'border-rose-300/50 bg-rose-500/14' : 'border-emerald-300/45 bg-emerald-500/12'}`}>
                          <p className={`text-sm font-semibold ${strongFlag ? 'text-rose-100' : 'text-emerald-100'}`}>
                            {strongFlag ? '!! INCONGRUENCE DETECTED !!' : 'Crossmodal Congruence Stable'}
                          </p>
                          <p className={`mt-1 text-xs ${strongFlag ? 'text-rose-100/80' : 'text-emerald-100/80'}`}>
                            {selected.incongruenceReason}
                          </p>
                          <div className="mt-3 space-y-2 text-xs text-white/76">
                            <div className="flex items-center justify-between">
                              <span>Temporal alignment</span>
                              <span className="text-cyan-100">Confirmed</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span>Signal correlation</span>
                              <span className={corr < 0 ? 'text-rose-200' : 'text-emerald-200'}>{corr.toFixed(2)}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span>Expression pattern</span>
                              <span className={strongFlag ? 'text-rose-200' : 'text-emerald-200'}>{strongFlag ? 'Non-congruent' : 'Congruent'}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="grid gap-5 xl:grid-cols-2">
                  <article className="rounded-[26px] border border-cyan-300/24 bg-[linear-gradient(180deg,rgba(8,18,33,0.96),rgba(4,10,20,0.98))] p-5 shadow-[0_24px_90px_rgba(0,0,0,0.35)]">
                    <p className="text-[11px] uppercase tracking-[0.22em] text-cyan-100/58">Signal Correlation</p>
                    <div className="mt-3 grid gap-4 lg:grid-cols-2">
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                        <svg viewBox="0 0 360 190" className="h-[190px] w-full">
                          <path d={linePath(warmthSeries, 360, 190)} fill="none" stroke="#7af3b6" strokeWidth="3" />
                          <path d={linePath(facialSeries, 360, 190)} fill="none" stroke="#ff6b8a" strokeWidth="2.5" />
                          <path d={linePath(physioSeries, 360, 190)} fill="none" stroke="#f6e36e" strokeWidth="2.1" opacity="0.9" />
                        </svg>
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-white/62">
                          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#7af3b6]" /> Warmth</span>
                          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#ff6b8a]" /> Tension</span>
                          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#f6e36e]" /> Physio</span>
                        </div>
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                        <svg viewBox="0 0 240 190" className="h-[190px] w-full">
                          <rect x="0" y="0" width="240" height="190" fill="transparent" />
                          {chronologicalSeries.map((entry, index) => {
                            const x = (entry.vocalWarmth / 100) * 220 + 10
                            const y = 180 - (entry.facialTension / 100) * 165
                            const isCurrent = entry.id === selected.id
                            const opacity = isCurrent ? 1 : clamp(0.25 + index / Math.max(chronologicalSeries.length, 1), 0.25, 0.85)
                            return <circle key={entry.id} cx={x} cy={y} r={isCurrent ? 5.4 : 3.4} fill={isCurrent ? '#b7f1ff' : '#4dc7ff'} opacity={opacity} />
                          })}
                        </svg>
                        <p className="mt-2 text-[11px] text-white/64">
                          Correlation coefficient: <span className="text-cyan-100">{corr.toFixed(2)}</span>
                        </p>
                      </div>
                    </div>
                  </article>

                  <article className="rounded-[26px] border border-cyan-300/24 bg-[linear-gradient(180deg,rgba(8,18,33,0.96),rgba(4,10,20,0.98))] p-5 shadow-[0_24px_90px_rgba(0,0,0,0.35)]">
                    <p className="text-[11px] uppercase tracking-[0.22em] text-cyan-100/58">Temporal Alignment</p>
                    <div className="mt-3 space-y-2">
                      {chronologicalSeries.slice(-12).map((entry) => {
                        const simultaneous = entry.vocalWarmth >= 60 && entry.facialTension >= 60
                        return (
                          <div key={entry.id} className="rounded-xl border border-white/10 bg-black/20 p-3">
                            <div className="mb-2 flex items-center justify-between text-[11px] text-white/55">
                              <span>{formatClock(entry.createdAt)}</span>
                              <span>{entry.mediaType.toUpperCase()} • {Math.round(entry.durationSec)}s</span>
                            </div>
                            <div className="space-y-1.5">
                              <div className="h-2 overflow-hidden rounded-full bg-white/8">
                                <div className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-emerald-300" style={{ width: `${entry.vocalWarmth}%` }} />
                              </div>
                              <div className="h-2 overflow-hidden rounded-full bg-white/8">
                                <div className="h-full rounded-full bg-gradient-to-r from-rose-300 to-red-400" style={{ width: `${entry.facialTension}%` }} />
                              </div>
                              <div className={`text-[10px] ${simultaneous ? 'text-rose-200' : 'text-emerald-200'}`}>
                                {simultaneous ? 'Audio and visual signals elevated in same frame window' : 'No strong temporal overlap'}
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </article>
                </section>

                <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
                  <article className="rounded-[26px] border border-cyan-300/24 bg-[linear-gradient(180deg,rgba(8,18,33,0.96),rgba(4,10,20,0.98))] p-5 shadow-[0_24px_90px_rgba(0,0,0,0.35)]">
                    <p className="text-[11px] uppercase tracking-[0.22em] text-cyan-100/58">ORACLE Result + LUCID Interpretation</p>
                    <div className="mt-3 grid gap-4 lg:grid-cols-2">
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                        <p className="text-xs uppercase tracking-[0.16em] text-white/45">Behavioral Summary</p>
                        <p className="mt-2 text-sm leading-6 text-white/76">{selected.behavioralSummary || 'No behavioral summary available for this log.'}</p>
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                        <p className="text-xs uppercase tracking-[0.16em] text-white/45">Transcript</p>
                        <p className="mt-2 line-clamp-6 text-sm leading-6 text-white/72">{selected.transcript || 'No transcript available.'}</p>
                      </div>
                    </div>
                  </article>

                  <article className="rounded-[26px] border border-cyan-300/24 bg-[linear-gradient(180deg,rgba(8,18,33,0.96),rgba(4,10,20,0.98))] p-5 shadow-[0_24px_90px_rgba(0,0,0,0.35)]">
                    <p className="text-[11px] uppercase tracking-[0.22em] text-cyan-100/58">Incongruence Event Log</p>
                    <div className="mt-3 space-y-2">
                      {incongruenceEvents.length > 0 ? (
                        incongruenceEvents.map((eventEntry) => (
                          <div key={eventEntry.id} className="rounded-xl border border-rose-300/35 bg-rose-500/12 p-3">
                            <div className="flex items-center justify-between text-[11px] text-rose-100/84">
                              <span>{eventEntry.avatarName}</span>
                              <span>{new Date(eventEntry.createdAt).toLocaleTimeString()}</span>
                            </div>
                            <p className="mt-1 text-xs text-rose-100/76">{eventEntry.incongruenceReason}</p>
                          </div>
                        ))
                      ) : (
                        <div className="rounded-xl border border-emerald-300/35 bg-emerald-500/12 p-3 text-xs text-emerald-100/85">
                          No incongruence events in this filtered view.
                        </div>
                      )}
                    </div>
                  </article>
                </section>
              </main>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
