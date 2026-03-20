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

  const incongruenceEvents = useMemo(
    () => filteredEntries.filter((entry) => entry.incongruence).slice(0, 8),
    [filteredEntries],
  )

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
                <section className="overflow-hidden rounded-[38px] border border-cyan-300/18 bg-[linear-gradient(180deg,rgba(7,16,29,0.96),rgba(3,9,16,0.985))] shadow-[0_42px_160px_rgba(0,0,0,0.56)]">
                  <div className="flex items-center justify-between border-b border-white/8 px-5 py-4 sm:px-7">
                    <div>
                      <p className="font-mono text-[11px] uppercase tracking-[0.42em] text-cyan-100/42">Oracle / Pattern Recognition</p>
                      <h2 className="mt-2 text-[2rem] font-semibold tracking-[0.04em] text-white sm:text-[2.4rem]">Crossmodal monitoring system</h2>
                    </div>
                    <div className="text-right">
                      <p className={`font-mono text-[13px] uppercase tracking-[0.18em] ${strongFlag ? 'text-rose-300' : 'text-emerald-300'}`}>{strongFlag ? 'Incongruence flagged' : 'Pattern stable'}</p>
                      <p className="mt-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 font-mono text-sm text-white/62">{selectedMoment}</p>
                    </div>
                  </div>

                  <div className="grid gap-0 xl:grid-cols-[420px_minmax(0,1fr)]">
                    <div className="border-b border-white/8 xl:border-b-0 xl:border-r border-white/8">
                      <div className="p-5 sm:p-6">
                        <div className="relative overflow-hidden rounded-[28px] border border-cyan-300/16 bg-[radial-gradient(circle_at_48%_16%,rgba(86,203,255,0.18),transparent_25%),linear-gradient(180deg,#0a1725_0%,#040b14_100%)] shadow-[inset_0_0_0_1px_rgba(133,220,255,0.04)]">
                          <div className="absolute inset-0 bg-[linear-gradient(transparent_0%,rgba(115,223,255,0.04)_49%,transparent_50%,transparent_100%)] bg-[length:100%_18px] opacity-60" />
                          <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,transparent_0%,rgba(2,8,16,0.16)_55%,rgba(2,8,16,0.84)_100%)]" />
                          {selected.mediaUrl && selected.mediaType === 'video' ? (
                            <video src={selected.mediaUrl} controls playsInline className="relative z-10 aspect-[4/5] w-full bg-black object-cover" />
                          ) : (
                            <div className="relative z-10 aspect-[4/5]">
                              <img src={selected.avatarImage} alt={selected.avatarName} className="h-full w-full object-cover opacity-74" />
                            </div>
                          )}
                          <div className="absolute inset-x-4 top-4 z-20 flex items-center justify-between gap-3">
                            <div className="rounded-full border border-cyan-200/18 bg-[#091321]/82 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.22em] text-cyan-100/74">
                              Live subject frame
                            </div>
                            <div className="rounded-full border border-white/12 bg-black/22 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-white/62">
                              {selected.mediaType}
                            </div>
                          </div>
                          <div className="absolute inset-x-5 bottom-5 z-20 rounded-[22px] border border-white/12 bg-black/34 px-4 py-3 backdrop-blur-md">
                            <p className="text-2xl font-semibold tracking-[0.04em] text-white">{selected.avatarName}</p>
                            <p className="mt-1 text-sm text-cyan-100/72">{selected.contactName} / {selectedMoment}</p>
                          </div>
                        </div>

                        <div className="mt-5 grid gap-3">
                          {sensorWaveforms.map((panel) => (
                            <div key={panel.key} className="rounded-[20px] border border-white/10 bg-black/22 px-4 py-3">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/42">{panel.label}</p>
                                  <p className="mt-1 text-lg text-white/88">{panel.metric}</p>
                                </div>
                                <div className="text-right">
                                  <p className="text-[28px] font-semibold leading-none" style={{ color: panel.stroke }}>{panel.value}%</p>
                                  <p className="mt-1 font-mono text-[11px] text-white/42">{levelDescriptor(panel.value)}</p>
                                </div>
                              </div>
                              <svg viewBox="0 0 300 48" className="mt-3 h-12 w-full">
                                <path d={linePath(panel.trace, 300, 48)} fill="none" stroke={panel.stroke} strokeWidth="2.3" />
                              </svg>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="p-5 sm:p-6">
                      <div className="rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(8,17,31,0.86),rgba(4,10,18,0.98))]">
                        <div className="flex items-center justify-between border-b border-white/8 px-5 py-4">
                          <h3 className="text-center text-[2rem] font-semibold tracking-[0.03em] text-white sm:flex-1">ORACLE CROSSMODAL ENGINE</h3>
                          <div className={`font-mono text-sm ${strongFlag ? 'text-rose-300' : 'text-cyan-100/42'}`}>{strongFlag ? 'Incongruence flagged' : 'Monitoring'}</div>
                        </div>

                        <div className="relative overflow-hidden px-5 py-5">
                          <div className="absolute inset-0 bg-[linear-gradient(transparent_0%,rgba(115,223,255,0.025)_49%,transparent_50%,transparent_100%)] bg-[length:100%_16px] opacity-70" />
                          <svg className="absolute inset-0 h-full w-full" viewBox="0 0 960 420" preserveAspectRatio="none" aria-hidden>
                            {engineNodes.map((node) => (
                              <path
                                key={node.key}
                                d={drawCurve(node.x + 200, node.y, 510, 210)}
                                fill="none"
                                stroke={node.key === 'auditory' ? '#8bf6b8' : node.key === 'facial' ? '#ff6f8d' : node.key === 'physio' ? '#f8df69' : '#f2a655'}
                                strokeWidth="3"
                                opacity="0.92"
                              />
                            ))}
                            <path
                              d={drawCurve(620, 210, 835, 210)}
                              fill="none"
                              stroke={strongFlag ? '#ff6a7f' : '#7ef0b4'}
                              strokeWidth="4"
                            />
                          </svg>

                          <div className="relative z-10 grid gap-6 xl:grid-cols-[310px_1fr_310px]">
                            <div className="space-y-4">
                              {sensorWaveforms.map((panel) => (
                                <div key={panel.key} className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-3">
                                  <div className="rounded-[18px] border border-white/12 bg-[#0b1624] p-3 text-center">
                                    <div className="mx-auto mb-2 h-7 w-7 rounded-full border border-white/10 bg-white/[0.04]" />
                                    <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/56">{panel.label}</p>
                                  </div>
                                  <div className="rounded-[18px] border border-white/12 bg-[#0b1624] p-3">
                                    <div className="flex items-center justify-between gap-3">
                                      <p className="text-[30px] leading-none text-white">{panel.label === 'Physio' ? 'Heart Rate' : panel.label === 'Gesture' ? 'Gesture' : panel.label === 'Facial' ? 'Tension' : 'Warmth'}</p>
                                      <span className="font-mono text-sm text-white/56">{panel.value}%</span>
                                    </div>
                                    <svg viewBox="0 0 180 38" className="mt-2 h-10 w-full">
                                      <path d={linePath(panel.trace, 180, 38)} fill="none" stroke={panel.stroke} strokeWidth="2.4" />
                                    </svg>
                                  </div>
                                </div>
                              ))}
                            </div>

                            <div className="flex items-center justify-center">
                              <div className="w-full max-w-[240px] rounded-[28px] border border-cyan-200/28 bg-[linear-gradient(180deg,rgba(124,173,255,0.22),rgba(108,158,241,0.1))] px-6 py-7 text-center shadow-[0_0_0_1px_rgba(157,220,255,0.16),0_0_54px_rgba(87,180,255,0.16)]">
                                <div className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full border border-white/16 bg-white/[0.05] text-white/72">◎</div>
                                <p className="text-[2.25rem] font-semibold tracking-[0.02em] text-white">ORACLE</p>
                                <p className="mt-1 text-[1.55rem] leading-tight text-white/90">Crossmodal Engine</p>
                              </div>
                            </div>

                            <div className={`rounded-[24px] border px-4 py-4 ${strongFlag ? 'border-rose-300/50 bg-[linear-gradient(180deg,rgba(169,49,54,0.65),rgba(101,22,28,0.38))]' : 'border-emerald-300/26 bg-[linear-gradient(180deg,rgba(15,58,46,0.48),rgba(7,25,20,0.34))]'}`}>
                              <p className={`font-mono text-[13px] uppercase tracking-[0.16em] ${diagnosticTone}`}>{strongFlag ? '!! INCONGRUENCE DETECTED !!' : 'Crossmodal congruence stable'}</p>
                              <p className={`mt-2 text-[2rem] font-semibold leading-none ${diagnosticTone}`}>{formatClock(selected.createdAt)}</p>
                              <div className="mt-4 space-y-3 rounded-[18px] border border-black/18 bg-black/20 p-4 text-sm text-white/86">
                                <div className="flex items-center justify-between">
                                  <span>Temporal Alignment:</span>
                                  <span className="rounded-md bg-cyan-300/14 px-2 py-1 text-cyan-100">Confirmed</span>
                                </div>
                                <div className="flex items-center justify-between">
                                  <span>Signal Correlation:</span>
                                  <span className={corr < 0 ? 'text-rose-100' : 'text-emerald-100'}>{corr.toFixed(2)}</span>
                                </div>
                                <div className="flex items-center justify-between">
                                  <span>Expression Patterns:</span>
                                  <span className={strongFlag ? 'text-rose-100' : 'text-emerald-100'}>{strongFlag ? 'Non-Congruent' : 'Congruent'}</span>
                                </div>
                                <div className="flex items-center justify-between">
                                  <span>Confidence:</span>
                                  <span>{selected.incongruenceScore}%</span>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="border-t border-white/8 px-5 py-5">
                          <div className="rounded-[24px] border border-white/10 bg-black/18 p-4">
                            <div className="mb-3 flex items-center justify-between">
                              <p className="font-mono text-[12px] uppercase tracking-[0.22em] text-white/44">Crossmodal Rules / Simultaneous Comparison</p>
                              <p className={`font-mono text-[12px] ${strongFlag ? 'text-rose-300' : 'text-emerald-300'}`}>{primaryDiagnostic}</p>
                            </div>
                            <div className="relative h-[230px] rounded-[18px] border border-white/8 bg-[#07111c] px-3 py-3">
                              {strongFlag ? <div className="absolute inset-y-4 left-[36%] w-[18%] rounded-lg bg-rose-500/16" /> : null}
                              <svg viewBox="0 0 760 180" className="relative z-10 h-full w-full">
                                <path d={linePath(warmthSeries, 760, 180)} fill="none" stroke="#8bf6b8" strokeWidth="3" />
                                <path d={linePath(facialSeries, 760, 180)} fill="none" stroke="#ff6f8d" strokeWidth="2.5" />
                              </svg>
                              <div className="absolute inset-x-4 bottom-4 flex items-center justify-between font-mono text-[11px] text-white/42">
                                <span>0</span>
                                <span>2</span>
                                <span>4</span>
                                <span>6</span>
                                <span>8</span>
                                <span>10</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="grid gap-5 xl:grid-cols-[minmax(0,1.08fr)_380px]">
                  <article className="rounded-[34px] border border-cyan-300/16 bg-[linear-gradient(180deg,rgba(7,16,29,0.96),rgba(3,9,16,0.985))] p-5 shadow-[0_36px_130px_rgba(0,0,0,0.5)]">
                    <div className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
                      <div>
                        <p className="font-mono text-[12px] uppercase tracking-[0.28em] text-cyan-100/42">Signal Comparison</p>
                        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
                          {comparisonMeters.map((item) => (
                            <div key={item.label} className="rounded-[24px] border border-white/10 bg-[#08111d] px-5 py-6">
                              <p className="font-mono text-[13px] uppercase tracking-[0.22em] text-white/58">{item.label}</p>
                              <p className="mt-2 text-lg text-white/48">{item.sublabel}</p>
                              <div className="mt-7 flex flex-col items-center">
                                <div className="flex h-[210px] w-[126px] items-end rounded-[24px] border border-white/12 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] p-3">
                                  <div className={`w-full rounded-[18px] bg-gradient-to-t ${item.accent}`} style={{ height: `${Math.max(item.value, 4)}%` }} />
                                </div>
                                <div className={`mt-5 text-5xl font-semibold ${item.text}`}>{item.value}%</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-5">
                        <div className={`rounded-[28px] border p-5 ${strongFlag ? 'border-rose-300/38 bg-[linear-gradient(180deg,rgba(134,24,30,0.44),rgba(35,9,13,0.92))]' : 'border-cyan-300/16 bg-[linear-gradient(180deg,rgba(11,34,39,0.68),rgba(8,25,28,0.94))]'}`}>
                          <p className="font-mono text-[12px] uppercase tracking-[0.28em] text-white/56">Incongruence Detection</p>
                          <p className={`mt-3 text-[2.4rem] font-semibold leading-none ${diagnosticTone}`}>{strongFlag ? 'INCONGRUENCE DETECTED' : 'SIGNALS CONGRUENT'}</p>
                          <p className={`mt-3 max-w-2xl text-sm leading-6 ${diagnosticTone}`}>{selected.incongruenceReason}</p>
                          <div className="mt-5 grid gap-3 sm:grid-cols-2">
                            <div className="rounded-[18px] border border-white/10 bg-black/20 p-3">
                              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-white/42">Timestamp</p>
                              <p className="mt-2 text-lg text-white">{selectedMoment}</p>
                            </div>
                            <div className="rounded-[18px] border border-white/10 bg-black/20 p-3">
                              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-white/42">Rule</p>
                              <p className="mt-2 text-lg text-white">Vocal / Facial Dissonance 14B</p>
                            </div>
                            <div className="rounded-[18px] border border-white/10 bg-black/20 p-3">
                              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-white/42">Confidence</p>
                              <p className="mt-2 text-lg text-white">{selected.incongruenceScore}%</p>
                            </div>
                            <div className="rounded-[18px] border border-white/10 bg-black/20 p-3">
                              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-white/42">Alignment Score</p>
                              <p className="mt-2 text-lg text-white">{alignmentScore}%</p>
                            </div>
                          </div>
                        </div>

                        <div className="grid gap-5 lg:grid-cols-2">
                          <article className="rounded-[28px] border border-white/10 bg-black/16 p-4">
                            <p className="font-mono text-[12px] uppercase tracking-[0.24em] text-cyan-100/42">Temporal Alignment</p>
                            <div className="mt-4 space-y-3">
                              {timelineTracks.slice(-5).map((track) => (
                                <div key={track.id} className="rounded-[18px] border border-white/8 bg-[#07111c] p-3">
                                  <div className="mb-2 flex items-center justify-between font-mono text-[11px] text-white/42">
                                    <span>{track.stamp}</span>
                                    <span>{track.simultaneous ? 'linked' : 'partial'}</span>
                                  </div>
                                  <div className="relative h-[48px] rounded-xl border border-white/8 bg-[#081321]">
                                    <div className="absolute top-[7px] h-2 rounded-full bg-gradient-to-r from-cyan-400 to-emerald-300" style={{ left: `${track.audioStart}%`, width: `${track.audioWidth}%` }} />
                                    <div className="absolute top-[19px] h-2 rounded-full bg-gradient-to-r from-rose-400 to-red-400" style={{ left: `${track.facialStart}%`, width: `${track.facialWidth}%` }} />
                                    <div className="absolute top-[31px] h-2 rounded-full bg-gradient-to-r from-amber-300 to-orange-300" style={{ left: `${track.gestureStart}%`, width: `${track.gestureWidth}%` }} />
                                    <div className={`absolute top-0 h-full w-px ${track.simultaneous ? 'bg-rose-300/80' : 'bg-cyan-200/42'}`} style={{ left: `${track.marker}%` }} />
                                  </div>
                                </div>
                              ))}
                            </div>
                          </article>

                          <article className="rounded-[28px] border border-white/10 bg-black/16 p-4">
                            <p className="font-mono text-[12px] uppercase tracking-[0.24em] text-cyan-100/42">Signal Correlation</p>
                            <div className="mt-4 rounded-[18px] border border-white/8 bg-[#07111c] p-3">
                              <svg viewBox="0 0 280 180" className="h-[180px] w-full">
                                {chronologicalSeries.map((entry, index) => {
                                  const x = 18 + (entry.vocalWarmth / 100) * 244
                                  const y = 160 - (entry.facialTension / 100) * 136
                                  const active = entry.id === selected.id
                                  const opacity = active ? 1 : clamp(0.25 + index / Math.max(chronologicalSeries.length, 1), 0.25, 0.84)
                                  return <circle key={entry.id} cx={x} cy={y} r={active ? 5 : 3.1} fill={active ? '#d5fbff' : '#5bcfff'} opacity={opacity} />
                                })}
                              </svg>
                            </div>
                            <p className="mt-3 text-sm text-white/64">Correlation coefficient <span className="text-cyan-100">{corr.toFixed(2)}</span></p>
                          </article>
                        </div>
                      </div>
                    </div>
                  </article>

                  <aside className="space-y-5">
                    <article className="rounded-[34px] border border-cyan-300/16 bg-[linear-gradient(180deg,rgba(7,16,29,0.96),rgba(3,9,16,0.985))] p-5 shadow-[0_36px_130px_rgba(0,0,0,0.5)]">
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-mono text-[12px] uppercase tracking-[0.28em] text-cyan-100/42">Focused Event Feed</p>
                        <p className="font-mono text-[11px] text-white/42">filtered only</p>
                      </div>
                      <div className="mt-4 space-y-2">
                        {filteredEntries.slice(0, 6).map((entry) => {
                          const active = entry.id === selected.id
                          return (
                            <button
                              key={entry.id}
                              type="button"
                              onClick={() => setSelectedId(entry.id)}
                              className={`w-full rounded-[18px] border p-3 text-left transition ${active ? 'border-cyan-300/42 bg-cyan-400/10' : 'border-white/10 bg-black/18 hover:border-cyan-300/24 hover:bg-white/[0.04]'}`}
                            >
                              <div className="flex items-center gap-3">
                                <img src={entry.avatarImage} alt={entry.avatarName} className="h-11 w-11 rounded-xl object-cover ring-1 ring-white/10" />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="truncate text-sm text-white">{entry.avatarName}</span>
                                    <span className="font-mono text-[11px] text-white/42">{formatClock(entry.createdAt)}</span>
                                  </div>
                                  <p className="mt-1 truncate text-xs text-cyan-100/70">{entry.contactName}</p>
                                  <div className="mt-2 flex items-center gap-2 font-mono text-[10px] text-white/60">
                                    <span>W {entry.vocalWarmth}%</span>
                                    <span>T {entry.facialTension}%</span>
                                    <span>P {entry.physioArousal}%</span>
                                  </div>
                                </div>
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </article>

                    <article className="rounded-[34px] border border-cyan-300/16 bg-[linear-gradient(180deg,rgba(7,16,29,0.96),rgba(3,9,16,0.985))] p-5 shadow-[0_36px_130px_rgba(0,0,0,0.5)]">
                      <p className="font-mono text-[12px] uppercase tracking-[0.28em] text-cyan-100/42">LUCID Interpretation</p>
                      <div className="mt-4 rounded-[20px] border border-white/10 bg-black/18 p-4">
                        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-white/42">Behavioral summary</p>
                        <p className="mt-2 text-sm leading-6 text-white/76">{selected.behavioralSummary || 'No behavioral summary available for this log.'}</p>
                      </div>
                      <div className="mt-4 rounded-[20px] border border-white/10 bg-black/18 p-4">
                        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-white/42">Transcript extract</p>
                        <p className="mt-2 text-sm leading-6 text-white/72">{selected.transcript || 'No transcript available.'}</p>
                      </div>
                    </article>

                    <article className="rounded-[34px] border border-cyan-300/16 bg-[linear-gradient(180deg,rgba(7,16,29,0.96),rgba(3,9,16,0.985))] p-5 shadow-[0_36px_130px_rgba(0,0,0,0.5)]">
                      <p className="font-mono text-[12px] uppercase tracking-[0.28em] text-cyan-100/42">Flagged Incongruence</p>
                      <div className="mt-4 space-y-2">
                        {incongruenceEvents.length > 0 ? (
                          incongruenceEvents.map((eventEntry) => (
                            <div key={eventEntry.id} className="rounded-[18px] border border-rose-300/26 bg-rose-500/10 p-3">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm text-rose-50">{eventEntry.avatarName}</span>
                                <span className="font-mono text-[11px] text-rose-100/68">{formatClock(eventEntry.createdAt)}</span>
                              </div>
                              <p className="mt-2 text-xs leading-5 text-rose-100/74">{eventEntry.incongruenceReason}</p>
                            </div>
                          ))
                        ) : (
                          <div className="rounded-[18px] border border-emerald-300/22 bg-emerald-500/10 p-3 text-sm text-emerald-100/82">
                            No incongruence events in the active filter scope.
                          </div>
                        )}
                      </div>
                    </article>
                  </aside>
                </section>
              </main>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
