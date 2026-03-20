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

function buildSignalTrace(level: number, variance: number, points: number, phase = 0): number[] {
  return Array.from({ length: points }, (_, index) => {
    const base = level
    const waveA = Math.sin((index + phase) * 0.55) * variance
    const waveB = Math.cos((index + phase) * 1.1) * variance * 0.42
    const pulse = index % 6 === 0 ? variance * 0.35 : 0
    return clamp(base + waveA + waveB + pulse, 2, 98)
  })
}

function levelDescriptor(value: number): string {
  if (value >= 80) return 'High'
  if (value >= 60) return 'Elevated'
  if (value >= 35) return 'Moderate'
  return 'Low'
}

function formatEventStamp(timestamp: string): string {
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
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

  const corr = useMemo(() => correlation(warmthSeries, facialSeries), [facialSeries, warmthSeries])

  const engineNodes: EngineNode[] = useMemo(
    () => [
      {
        key: 'auditory',
        label: 'Auditory / Warmth',
        value: selected?.vocalWarmth ?? 0,
        accent: 'from-emerald-300 to-lime-300',
        x: 120,
        y: 86,
      },
      {
        key: 'facial',
        label: 'Facial / Tension',
        value: selected?.facialTension ?? 0,
        accent: 'from-rose-300 to-red-400',
        x: 120,
        y: 178,
      },
      {
        key: 'physio',
        label: 'Physio / Arousal',
        value: selected?.physioArousal ?? 0,
        accent: 'from-amber-300 to-yellow-300',
        x: 120,
        y: 270,
      },
      {
        key: 'gesture',
        label: 'Gesture / Load',
        value: selected?.gestureLoad ?? 0,
        accent: 'from-cyan-300 to-sky-300',
        x: 120,
        y: 362,
      },
    ],
    [selected],
  )

  const strongFlag = selected?.incongruence ?? false
  const selectedMoment = selected ? formatEventStamp(selected.createdAt) : ''
  const alignmentScore = selected ? Math.round((selected.vocalWarmth * 0.32) + ((100 - selected.facialTension) * 0.28) + (selected.gestureLoad * 0.14) + ((1 - Math.abs(corr)) * 26)) : 0
  const sensorWaveforms = selected
    ? [
        {
          key: 'auditory',
          label: 'Auditory',
          metric: 'Vocal warmth',
          value: selected.vocalWarmth,
          stroke: '#8df7b7',
          trace: buildSignalTrace(selected.vocalWarmth, 10, 24, 0),
        },
        {
          key: 'facial',
          label: 'Facial',
          metric: 'Facial tension',
          value: selected.facialTension,
          stroke: '#ff6d8f',
          trace: buildSignalTrace(selected.facialTension, 18, 24, 2),
        },
        {
          key: 'physio',
          label: 'Physio',
          metric: 'Arousal load',
          value: selected.physioArousal,
          stroke: '#ffe36e',
          trace: buildSignalTrace(selected.physioArousal, 14, 24, 5),
        },
        {
          key: 'gesture',
          label: 'Gesture',
          metric: 'Body activity',
          value: selected.gestureLoad,
          stroke: '#78dfff',
          trace: buildSignalTrace(selected.gestureLoad, 16, 24, 8),
        },
      ]
    : []
  const comparisonMeters = selected
    ? [
        {
          label: 'Vocal Warmth',
          sublabel: 'Prosody audio',
          value: selected.vocalWarmth,
          accent: 'from-[#54f0b1] via-[#b9fb64] to-[#ffe437]',
          text: 'text-[#e6ffd0]',
        },
        {
          label: 'Facial Tension',
          sublabel: 'Action units',
          value: selected.facialTension,
          accent: 'from-[#ff7f7a] via-[#ff6175] to-[#ffb14b]',
          text: 'text-[#ffd5d9]',
        },
      ]
    : []
  const timelineTracks = chronologicalSeries.slice(-10).map((entry, index) => {
    const start = 8 + index * 8
    const audioWidth = clamp(entry.vocalWarmth * 0.62, 18, 78)
    const facialWidth = clamp(entry.facialTension * 0.55, 16, 70)
    const gestureWidth = clamp(entry.gestureLoad * 0.48, 12, 58)
    const marker = start + Math.max(audioWidth * 0.38, facialWidth * 0.42)
    return {
      id: entry.id,
      stamp: formatClock(entry.createdAt),
      audioStart: start,
      audioWidth,
      facialStart: start + 10,
      facialWidth,
      gestureStart: start + 24,
      gestureWidth,
      marker,
      simultaneous: entry.vocalWarmth >= 62 && entry.facialTension >= 58,
    }
  })
  const primaryDiagnostic = strongFlag ? 'Incongruence flagged' : 'Crossmodal pattern stable'
  const diagnosticTone = strongFlag ? 'text-rose-100' : 'text-emerald-100'

  return (
    <div className="min-h-[100dvh] bg-[radial-gradient(circle_at_12%_0%,rgba(50,218,255,0.18),transparent_26%),radial-gradient(circle_at_100%_8%,rgba(35,214,182,0.12),transparent_22%),linear-gradient(180deg,#02060d_0%,#06101b_42%,#030810_100%)] text-white">
      <div
        className="mx-auto w-full max-w-[1760px] px-4 sm:px-6 lg:px-8"
        style={{
          paddingTop: 'max(1.1rem, env(safe-area-inset-top))',
          paddingBottom: 'max(1.4rem, env(safe-area-inset-bottom))',
        }}
      >
        <header className="rounded-[30px] border border-cyan-300/22 bg-[linear-gradient(180deg,rgba(7,18,34,0.95),rgba(4,10,20,0.985))] p-5 shadow-[0_38px_140px_rgba(0,0,0,0.52)] backdrop-blur-xl sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div>
              <p className="text-[11px] uppercase tracking-[0.42em] text-cyan-100/52">Extended Perception Dashboard</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-[0.03em] text-white sm:text-[2.35rem]">ORACLE Crossmodal Pattern Recognition</h1>
              <p className="mt-2 max-w-4xl text-sm text-white/62 sm:text-[15px]">
                Forensic alignment between prosody, facial Action Units, body language, and event-level crossmodal incongruence.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs uppercase tracking-[0.2em] text-white/54">
                Live board / filtered scope
              </div>
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

          <div className="mt-5 grid gap-3 lg:grid-cols-12">
            <label className="flex flex-col gap-2 text-[11px] uppercase tracking-[0.18em] text-white/45 lg:col-span-2">
              Avatar
              <select value={avatarFilter} onChange={(event) => setAvatarFilter(event.target.value)} className="rounded-2xl border border-white/14 bg-[#091322] px-3 py-2.5 text-sm tracking-normal text-white outline-none transition focus:border-cyan-300/60">
                {avatarOptions.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-2 text-[11px] uppercase tracking-[0.18em] text-white/45 lg:col-span-2">
              User / Contact
              <select value={contactFilter} onChange={(event) => setContactFilter(event.target.value)} className="rounded-2xl border border-white/14 bg-[#091322] px-3 py-2.5 text-sm tracking-normal text-white outline-none transition focus:border-cyan-300/60">
                {contactOptions.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-2 text-[11px] uppercase tracking-[0.18em] text-white/45 lg:col-span-2">
              Media
              <select value={mediaFilter} onChange={(event) => setMediaFilter(event.target.value as MediaFilter)} className="rounded-2xl border border-white/14 bg-[#091322] px-3 py-2.5 text-sm tracking-normal text-white outline-none transition focus:border-cyan-300/60">
                <option value="all">All</option>
                <option value="audio">Audio</option>
                <option value="video">Video</option>
                <option value="text">Text</option>
              </select>
            </label>
            <label className="flex flex-col gap-2 text-[11px] uppercase tracking-[0.18em] text-white/45 lg:col-span-2">
              Time Window
              <select value={timeWindow} onChange={(event) => setTimeWindow(event.target.value as TimeWindow)} className="rounded-2xl border border-white/14 bg-[#091322] px-3 py-2.5 text-sm tracking-normal text-white outline-none transition focus:border-cyan-300/60">
                <option value="24h">Last 24h</option>
                <option value="7d">Last 7d</option>
                <option value="30d">Last 30d</option>
                <option value="all">All</option>
              </select>
            </label>
            <label className="flex flex-col gap-2 text-[11px] uppercase tracking-[0.18em] text-white/45 lg:col-span-4">
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
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white/62">
              Focused review, not raw dump
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
          <div className="mt-6">
            {selected ? (
              <main className="space-y-6">
                <section className="overflow-hidden rounded-[40px] border border-cyan-300/14 bg-[linear-gradient(180deg,rgba(5,11,21,0.985),rgba(3,8,15,0.995))] shadow-[0_50px_170px_rgba(0,0,0,0.6)]">
                  <div className="flex items-center justify-between border-b border-white/6 px-5 py-4 sm:px-7">
                    <div>
                      <p className="font-mono text-[11px] uppercase tracking-[0.42em] text-cyan-100/36">Oracle / Pattern Recognition</p>
                      <p className="mt-2 text-[2.25rem] font-semibold tracking-[0.03em] text-white sm:text-[2.7rem]">Crossmodal monitoring system</p>
                    </div>
                    <div className="text-right">
                      <p className={`font-mono text-[13px] uppercase tracking-[0.24em] ${strongFlag ? 'text-rose-300' : 'text-emerald-300'}`}>{strongFlag ? 'Incongruence flagged' : 'Pattern stable'}</p>
                      <p className="mt-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 font-mono text-sm text-white/56">{selectedMoment}</p>
                    </div>
                  </div>

                  <div className="grid gap-0 xl:grid-cols-[390px_minmax(0,1fr)]">
                    <div className="border-b border-white/6 xl:border-b-0 xl:border-r xl:border-white/6">
                      <div className="space-y-4 p-5 sm:p-6">
                        <div className="relative overflow-hidden rounded-[30px] border border-cyan-300/12 bg-[radial-gradient(circle_at_50%_12%,rgba(82,199,255,0.17),transparent_24%),linear-gradient(180deg,#0a1424_0%,#050a12_100%)]">
                          <div className="absolute inset-0 bg-[linear-gradient(transparent_0%,rgba(100,224,255,0.03)_49%,transparent_50%,transparent_100%)] bg-[length:100%_18px] opacity-70" />
                          {selected.mediaUrl && selected.mediaType === 'video' ? (
                            <video src={selected.mediaUrl} controls playsInline className="relative z-10 aspect-[4/5] w-full bg-black object-cover" />
                          ) : (
                            <img src={selected.avatarImage} alt={selected.avatarName} className="relative z-10 aspect-[4/5] w-full object-cover opacity-78" />
                          )}
                          <div className="absolute inset-x-4 top-4 z-20 flex items-center justify-between">
                            <div className="rounded-full border border-cyan-200/18 bg-[#0a1220]/82 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.22em] text-cyan-100/76">Live subject frame</div>
                            <div className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-white/62">{selected.mediaType}</div>
                          </div>
                          <div className="absolute inset-x-4 bottom-4 z-20 rounded-[22px] border border-white/12 bg-[#0a1020]/78 px-4 py-4 backdrop-blur-md">
                            <p className="text-[2rem] font-semibold tracking-[0.02em] text-white">{selected.avatarName}</p>
                            <p className="mt-1 text-lg text-cyan-100/66">{selected.contactName} / {selectedMoment}</p>
                          </div>
                        </div>

                        {sensorWaveforms.map((panel) => (
                          <div key={panel.key} className="rounded-[22px] border border-white/8 bg-[#060d17] px-4 py-4">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-white/40">{panel.label}</p>
                                <p className="mt-2 text-[1.8rem] leading-none text-white">{panel.metric}</p>
                              </div>
                              <div className="text-right">
                                <p className="text-[2.2rem] font-semibold leading-none" style={{ color: panel.stroke }}>{panel.value}%</p>
                                <p className="mt-1 font-mono text-[11px] text-white/36">{levelDescriptor(panel.value)}</p>
                              </div>
                            </div>
                            <svg viewBox="0 0 300 42" className="mt-4 h-10 w-full">
                              <path d={linePath(panel.trace, 300, 42)} fill="none" stroke={panel.stroke} strokeWidth="2.5" />
                            </svg>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="p-5 sm:p-6">
                      <div className="overflow-hidden rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(7,15,27,0.98),rgba(4,9,17,0.995))]">
                        <div className="flex items-center justify-between border-b border-white/6 px-5 py-4">
                          <div className="flex-1 text-center text-[2.4rem] font-semibold tracking-[0.03em] text-white">ORACLE CROSSMODAL ENGINE</div>
                          <div className={`font-mono text-sm ${strongFlag ? 'text-rose-300' : 'text-cyan-100/36'}`}>{strongFlag ? 'Alert' : 'Monitoring'}</div>
                        </div>

                        <div className="relative overflow-hidden px-5 py-5">
                          <div className="absolute inset-0 bg-[linear-gradient(180deg,transparent_0%,rgba(91,182,255,0.03)_50%,transparent_100%)]" />
                          <div className="absolute inset-0 bg-[linear-gradient(transparent_0%,rgba(103,222,255,0.022)_49%,transparent_50%,transparent_100%)] bg-[length:100%_15px] opacity-70" />
                          <svg className="absolute inset-0 h-full w-full" viewBox="0 0 980 420" preserveAspectRatio="none" aria-hidden>
                            {engineNodes.map((node) => (
                              <path
                                key={node.key}
                                d={drawCurve(node.x + 245, node.y, 550, 210)}
                                fill="none"
                                stroke={node.key === 'auditory' ? '#8cf4b8' : node.key === 'facial' ? '#ff6f8d' : node.key === 'physio' ? '#f4dc6c' : '#f3a758'}
                                strokeWidth="3.4"
                                opacity="0.96"
                              />
                            ))}
                            <path
                              d={drawCurve(650, 210, 860, 210)}
                              fill="none"
                              stroke={strongFlag ? '#ff6f82' : '#7df0b3'}
                              strokeWidth="4.2"
                              opacity="0.96"
                            />
                          </svg>

                          <div className="relative z-10 grid gap-6 xl:grid-cols-[360px_1fr_310px]">
                            <div className="space-y-4 pt-5">
                              {sensorWaveforms.map((panel) => (
                                <div key={panel.key} className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-3">
                                  <div className="rounded-[20px] border border-white/10 bg-[#0a1422] p-3 text-center">
                                    <div className="mx-auto mb-3 h-9 w-9 rounded-full border border-white/10 bg-white/[0.04]" />
                                    <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-white/56">{panel.label}</p>
                                  </div>
                                  <div className="rounded-[22px] border border-white/10 bg-[#0a1422] px-4 py-3">
                                    <div className="flex items-center justify-between gap-3">
                                      <p className="text-[2rem] leading-none text-white">{panel.label === 'Physio' ? 'Heart Rate' : panel.label === 'Gesture' ? 'Gesture' : panel.label === 'Facial' ? 'Tension' : 'Warmth'}</p>
                                      <span className="font-mono text-lg text-white/58">{panel.value}%</span>
                                    </div>
                                    <svg viewBox="0 0 210 34" className="mt-3 h-9 w-full">
                                      <path d={linePath(panel.trace, 210, 34)} fill="none" stroke={panel.stroke} strokeWidth="2.5" />
                                    </svg>
                                  </div>
                                </div>
                              ))}
                            </div>

                            <div className="flex items-center justify-center">
                              <div className="relative w-full max-w-[300px] rounded-[30px] border border-cyan-200/26 bg-[linear-gradient(180deg,rgba(117,161,234,0.24),rgba(97,140,207,0.12))] px-6 py-10 text-center shadow-[0_0_0_1px_rgba(157,220,255,0.16),0_0_64px_rgba(87,180,255,0.11)]">
                                <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full border border-white/14 bg-white/[0.05] text-white/80">◎</div>
                                <p className="text-[3rem] font-semibold tracking-[0.02em] text-white">ORACLE</p>
                                <p className="mt-2 text-[1.8rem] leading-tight text-white/88">Crossmodal Engine</p>
                              </div>
                            </div>

                            <div className={`rounded-[28px] border px-5 py-5 ${strongFlag ? 'border-rose-300/46 bg-[linear-gradient(180deg,rgba(167,53,57,0.72),rgba(92,22,27,0.38))]' : 'border-emerald-300/24 bg-[linear-gradient(180deg,rgba(17,64,51,0.54),rgba(7,25,20,0.34))]'}`}>
                              <p className={`font-mono text-[14px] uppercase tracking-[0.18em] ${diagnosticTone}`}>{strongFlag ? '!! INCONGRUENCE DETECTED !!' : 'Crossmodal congruence stable'}</p>
                              <p className={`mt-3 text-[3rem] font-semibold leading-none ${diagnosticTone}`}>{formatClock(selected.createdAt)}</p>
                              <div className="mt-5 rounded-[20px] border border-black/18 bg-black/22 p-4">
                                <div className="space-y-4 text-[1.05rem] text-white/88">
                                  <div className="flex items-center justify-between gap-4">
                                    <span>Temporal Alignment:</span>
                                    <span className="rounded-md bg-cyan-300/14 px-3 py-1 text-cyan-100">Confirmed</span>
                                  </div>
                                  <div className="flex items-center justify-between gap-4">
                                    <span>Signal Correlation:</span>
                                    <span className={corr < 0 ? 'text-rose-100' : 'text-emerald-100'}>{corr.toFixed(2)}</span>
                                  </div>
                                  <div className="flex items-center justify-between gap-4">
                                    <span>Expression Patterns:</span>
                                    <span className={strongFlag ? 'text-rose-100' : 'text-emerald-100'}>{strongFlag ? 'Non-Congruent' : 'Congruent'}</span>
                                  </div>
                                  <div className="flex items-center justify-between gap-4">
                                    <span>Confidence:</span>
                                    <span>{selected.incongruenceScore}%</span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="border-t border-white/6 px-5 py-5">
                          <div className="rounded-[24px] border border-white/8 bg-[#06101b] p-4">
                            <div className="mb-4 flex items-center justify-between">
                              <p className="font-mono text-[12px] uppercase tracking-[0.24em] text-white/42">Crossmodal Rules / Simultaneous Comparison</p>
                              <p className={`font-mono text-[12px] ${strongFlag ? 'text-rose-300' : 'text-emerald-300'}`}>{primaryDiagnostic}</p>
                            </div>
                            <div className="relative h-[235px] rounded-[20px] border border-white/8 bg-[#07111d] px-3 py-3">
                              {strongFlag ? <div className="absolute inset-y-4 left-[38%] w-[18%] rounded-lg bg-rose-500/16" /> : null}
                              <svg viewBox="0 0 760 180" className="relative z-10 h-full w-full">
                                <path d={linePath(warmthSeries, 760, 180)} fill="none" stroke="#8cf4b8" strokeWidth="3.4" />
                                <path d={linePath(facialSeries, 760, 180)} fill="none" stroke="#ff6f8d" strokeWidth="2.7" />
                              </svg>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
                  <article className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)_300px]">
                    <div className="rounded-[30px] border border-cyan-300/12 bg-[linear-gradient(180deg,rgba(6,13,23,0.98),rgba(3,8,15,0.99))] p-5">
                      <p className="font-mono text-[12px] uppercase tracking-[0.28em] text-cyan-100/40">Signal Comparison</p>
                      <div className="mt-5 space-y-5">
                        {comparisonMeters.map((item) => (
                          <div key={item.label} className="rounded-[22px] border border-white/8 bg-[#08111d] px-4 py-5">
                            <p className="font-mono text-[13px] uppercase tracking-[0.22em] text-white/56">{item.label}</p>
                            <p className="mt-2 text-lg text-white/42">{item.sublabel}</p>
                            <div className="mt-7 flex flex-col items-center">
                              <div className="flex h-[210px] w-[132px] items-end rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.015))] p-3">
                                <div className={`w-full rounded-[18px] bg-gradient-to-t ${item.accent}`} style={{ height: `${Math.max(item.value, 4)}%` }} />
                              </div>
                              <div className={`mt-5 text-[4rem] font-semibold leading-none ${item.text}`}>{item.value}%</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-5">
                      <div className={`rounded-[30px] border p-5 ${strongFlag ? 'border-rose-300/32 bg-[linear-gradient(180deg,rgba(131,22,29,0.48),rgba(33,8,12,0.94))]' : 'border-emerald-300/18 bg-[linear-gradient(180deg,rgba(9,37,35,0.62),rgba(5,14,18,0.94))]'}`}>
                        <p className="font-mono text-[12px] uppercase tracking-[0.28em] text-white/56">Incongruence Detection</p>
                        <p className={`mt-4 text-[2.7rem] font-semibold leading-none ${diagnosticTone}`}>{strongFlag ? 'INCONGRUENCE DETECTED' : 'SIGNALS CONGRUENT'}</p>
                        <p className={`mt-4 max-w-3xl text-sm leading-6 ${diagnosticTone}`}>{selected.incongruenceReason}</p>
                        <div className="mt-5 grid gap-3 md:grid-cols-2">
                          <div className="rounded-[18px] border border-white/10 bg-black/20 p-4">
                            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/38">Timestamp</p>
                            <p className="mt-2 text-2xl text-white">{selectedMoment}</p>
                          </div>
                          <div className="rounded-[18px] border border-white/10 bg-black/20 p-4">
                            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/38">Rule</p>
                            <p className="mt-2 text-2xl text-white">Vocal / Facial Dissonance 14B</p>
                          </div>
                          <div className="rounded-[18px] border border-white/10 bg-black/20 p-4">
                            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/38">Confidence</p>
                            <p className="mt-2 text-2xl text-white">{selected.incongruenceScore}%</p>
                          </div>
                          <div className="rounded-[18px] border border-white/10 bg-black/20 p-4">
                            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/38">Alignment Score</p>
                            <p className="mt-2 text-2xl text-white">{alignmentScore}%</p>
                          </div>
                        </div>
                      </div>

                      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
                        <article className="rounded-[30px] border border-cyan-300/12 bg-[linear-gradient(180deg,rgba(6,13,23,0.98),rgba(3,8,15,0.99))] p-5">
                          <p className="font-mono text-[12px] uppercase tracking-[0.28em] text-cyan-100/40">Temporal Alignment</p>
                          <div className="mt-5 space-y-4">
                            {timelineTracks.slice(-5).map((track) => (
                              <div key={track.id} className="rounded-[20px] border border-white/8 bg-[#07111d] p-4">
                                <div className="mb-3 flex items-center justify-between font-mono text-[11px] text-white/40">
                                  <span>{track.stamp}</span>
                                  <span>{track.simultaneous ? 'aligned' : 'partial'}</span>
                                </div>
                                <div className="relative h-[72px] rounded-[18px] border border-white/8 bg-[#091423]">
                                  <div className="absolute top-[12px] h-3 rounded-full bg-gradient-to-r from-cyan-400 to-emerald-300" style={{ left: `${track.audioStart}%`, width: `${track.audioWidth}%` }} />
                                  <div className="absolute top-[31px] h-3 rounded-full bg-gradient-to-r from-rose-400 to-red-400" style={{ left: `${track.facialStart}%`, width: `${track.facialWidth}%` }} />
                                  <div className="absolute top-[50px] h-3 rounded-full bg-gradient-to-r from-amber-300 to-orange-300" style={{ left: `${track.gestureStart}%`, width: `${track.gestureWidth}%` }} />
                                  <div className={`absolute top-0 h-full w-px ${track.simultaneous ? 'bg-rose-300/80' : 'bg-cyan-200/38'}`} style={{ left: `${track.marker}%` }} />
                                </div>
                              </div>
                            ))}
                          </div>
                        </article>

                        <article className="rounded-[30px] border border-cyan-300/12 bg-[linear-gradient(180deg,rgba(6,13,23,0.98),rgba(3,8,15,0.99))] p-5">
                          <p className="font-mono text-[12px] uppercase tracking-[0.28em] text-cyan-100/40">Signal Correlation</p>
                          <div className="mt-5 rounded-[22px] border border-white/8 bg-[#07111d] p-4">
                            <svg viewBox="0 0 260 220" className="h-[220px] w-full">
                              {chronologicalSeries.map((entry, index) => {
                                const x = 20 + (entry.vocalWarmth / 100) * 220
                                const y = 190 - (entry.facialTension / 100) * 160
                                const active = entry.id === selected.id
                                const opacity = active ? 1 : clamp(0.24 + index / Math.max(chronologicalSeries.length, 1), 0.24, 0.82)
                                return <circle key={entry.id} cx={x} cy={y} r={active ? 6 : 3.2} fill={active ? '#d5fbff' : '#62d2ff'} opacity={opacity} />
                              })}
                            </svg>
                          </div>
                          <p className="mt-4 text-[1.1rem] text-white/72">Correlation coefficient <span className="text-cyan-100">{corr.toFixed(2)}</span></p>
                        </article>
                      </div>
                    </div>

                    <aside className="space-y-5">
                      <article className="rounded-[30px] border border-cyan-300/12 bg-[linear-gradient(180deg,rgba(6,13,23,0.98),rgba(3,8,15,0.99))] p-5">
                        <div className="flex items-center justify-between gap-3">
                          <p className="font-mono text-[12px] uppercase tracking-[0.28em] text-cyan-100/40">Focused Event Feed</p>
                          <p className="font-mono text-[11px] text-white/34">filtered</p>
                        </div>
                        <div className="mt-4 space-y-2">
                          {filteredEntries.slice(0, 5).map((entry) => {
                            const active = entry.id === selected.id
                            return (
                              <button
                                key={entry.id}
                                type="button"
                                onClick={() => setSelectedId(entry.id)}
                                className={`w-full rounded-[18px] border p-3 text-left transition ${active ? 'border-cyan-300/42 bg-cyan-400/10' : 'border-white/8 bg-[#07111d] hover:border-cyan-300/22 hover:bg-white/[0.03]'}`}
                              >
                                <div className="flex items-center gap-3">
                                  <img src={entry.avatarImage} alt={entry.avatarName} className="h-11 w-11 rounded-xl object-cover ring-1 ring-white/10" />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="truncate text-sm text-white">{entry.avatarName}</span>
                                      <span className="font-mono text-[11px] text-white/36">{formatClock(entry.createdAt)}</span>
                                    </div>
                                    <p className="mt-1 truncate text-xs text-cyan-100/64">{entry.contactName}</p>
                                  </div>
                                </div>
                              </button>
                            )
                          })}
                        </div>
                      </article>

                      <article className="rounded-[30px] border border-cyan-300/12 bg-[linear-gradient(180deg,rgba(6,13,23,0.98),rgba(3,8,15,0.99))] p-5">
                        <p className="font-mono text-[12px] uppercase tracking-[0.28em] text-cyan-100/40">LUCID Interpretation</p>
                        <div className="mt-4 rounded-[18px] border border-white/8 bg-[#07111d] p-4">
                          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-white/38">Behavioral summary</p>
                          <p className="mt-3 text-sm leading-6 text-white/74">{selected.behavioralSummary || 'No behavioral summary available for this log.'}</p>
                        </div>
                      </article>
                    </aside>
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
