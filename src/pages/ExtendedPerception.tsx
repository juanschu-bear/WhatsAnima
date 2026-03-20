import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { resolveAvatarUrl } from '../lib/avatars'

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
  avatarName: string
  avatarImage: string
  contactName: string
  transcript: string
  behavioralSummary: string
  prosodicSummary: Record<string, unknown>
  facialAnalysis: Record<string, unknown>
  bodyLanguage: Record<string, unknown>
  mediaType: string
  durationSec: number
  vocalWarmth: number
  facialTension: number
  bodyActivation: number
  incongruence: boolean
}

const FLOW_NODES = ['Auditory', 'Facial', 'Body Language', 'ORACLE Engine', 'Result']

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function pickFirstNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = toNumber(source[key])
    if (value != null) return value
  }
  return null
}

function normalizePercentLike(value: number | null, fallback = 50): number {
  if (value == null) return fallback
  if (value <= 1) return clamp(value * 100, 0, 100)
  return clamp(value, 0, 100)
}

function normalizeBodyLanguageSummary(source: Record<string, unknown>): string {
  const summary = source.summary
  if (typeof summary === 'string' && summary.trim()) return summary.trim()
  const parts = [source.posture_summary, source.hand_gesture_summary, source.movement_summary]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
  return parts.join(' • ')
}

function computeVocalWarmth(prosodicSummary: Record<string, unknown>): number {
  const stabilityRaw = pickFirstNumber(prosodicSummary, ['voice_stability', 'harmonic_to_noise_ratio'])
  const tremorRaw = pickFirstNumber(prosodicSummary, ['voice_tremor', 'jitter', 'shimmer'])
  const rateRaw = pickFirstNumber(prosodicSummary, ['speaking_rate_wps', 'speaking_rate'])
  const pauseRaw = pickFirstNumber(prosodicSummary, ['average_pause_ms', 'mean_pause_duration'])

  const stability = normalizePercentLike(stabilityRaw, 58) / 100
  const tremor = normalizePercentLike(tremorRaw, 18) / 100
  const rate = rateRaw != null ? clamp(1 - Math.abs(rateRaw - 2) / 2, 0, 1) : 0.55
  const pause = pauseRaw != null ? clamp(1 - pauseRaw / 2500, 0, 1) : 0.52

  const score = (stability * 0.42 + (1 - tremor) * 0.26 + rate * 0.2 + pause * 0.12) * 100
  return Math.round(clamp(score, 0, 100))
}

function readActionUnitMap(facialAnalysis: Record<string, unknown>): Record<string, number> {
  const source = (facialAnalysis.au_averages || facialAnalysis.action_units || facialAnalysis.au_scores || {}) as Record<string, unknown>
  const result: Record<string, number> = {}
  for (const [key, raw] of Object.entries(source)) {
    const value = toNumber(raw)
    if (value == null) continue
    const normalizedValue = value <= 1 ? value : value / 100
    result[key.toLowerCase().replace(/[^a-z0-9]/g, '')] = clamp(normalizedValue, 0, 1)
  }
  return result
}

function readEmotionProfile(facialAnalysis: Record<string, unknown>): Record<string, number> {
  const source = (
    facialAnalysis.emotion_profile ||
    facialAnalysis.emotion_percentages ||
    facialAnalysis.emotions ||
    facialAnalysis.emotion_distribution ||
    {}
  ) as Record<string, unknown>
  const result: Record<string, number> = {}
  for (const [key, raw] of Object.entries(source)) {
    const value = toNumber(raw)
    if (value == null) continue
    const normalized = value <= 1 ? value : value / 100
    result[key.toLowerCase()] = clamp(normalized, 0, 1)
  }
  return result
}

function computeBodyActivation(bodyLanguage: Record<string, unknown>): number {
  const numeric = pickFirstNumber(bodyLanguage, ['movement_intensity', 'gesture_intensity', 'posture_tension'])
  if (numeric != null) {
    return Math.round(normalizePercentLike(numeric, 45))
  }
  const summary = normalizeBodyLanguageSummary(bodyLanguage).toLowerCase()
  if (!summary) return 45
  let score = 45
  if (/(rigid|closed|guarded|stiff|tense|fidget|restless)/.test(summary)) score += 18
  if (/(open|relaxed|steady|calm|fluid)/.test(summary)) score -= 10
  return Math.round(clamp(score, 0, 100))
}

function computeFacialTension(
  facialAnalysis: Record<string, unknown>,
  bodyLanguage: Record<string, unknown>,
): number {
  const aus = readActionUnitMap(facialAnalysis)
  const emotions = readEmotionProfile(facialAnalysis)

  const auScore =
    (aus.au4 ?? 0) * 0.3 +
    (aus.au7 ?? 0) * 0.18 +
    (aus.au17 ?? 0) * 0.16 +
    (aus.au23 ?? 0) * 0.18 +
    (aus.au24 ?? 0) * 0.18

  const emotionScore =
    (emotions.anger ?? 0) * 0.45 +
    (emotions.fear ?? 0) * 0.2 +
    (emotions.disgust ?? 0) * 0.15 +
    (emotions.sadness ?? 0) * 0.1 +
    (emotions.surprise ?? 0) * 0.1

  const bodyActivation = computeBodyActivation(bodyLanguage) / 100
  const score = (auScore * 0.58 + emotionScore * 0.28 + bodyActivation * 0.14) * 100
  return Math.round(clamp(score, 0, 100))
}

function formatTime(timestamp: string) {
  const date = new Date(timestamp)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function linePath(values: number[], width: number, height: number, min = 0, max = 100): string {
  if (values.length === 0) return ''
  const range = max - min || 1
  const stepX = values.length > 1 ? width / (values.length - 1) : 0
  return values
    .map((value, index) => {
      const x = index * stepX
      const normalized = clamp((value - min) / range, 0, 1)
      const y = height - normalized * height
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(' ')
}

function correlation(entries: SignalEntry[]): number {
  if (entries.length < 2) return 0
  const x = entries.map((entry) => entry.vocalWarmth)
  const y = entries.map((entry) => entry.facialTension)
  const meanX = x.reduce((sum, value) => sum + value, 0) / x.length
  const meanY = y.reduce((sum, value) => sum + value, 0) / y.length
  let numerator = 0
  let denX = 0
  let denY = 0
  for (let index = 0; index < x.length; index += 1) {
    const dx = x[index] - meanX
    const dy = y[index] - meanY
    numerator += dx * dy
    denX += dx * dx
    denY += dy * dy
  }
  const denominator = Math.sqrt(denX * denY)
  if (!Number.isFinite(denominator) || denominator <= 0) return 0
  return clamp(numerator / denominator, -1, 1)
}

function deriveEntries(payload: PerceptionDashboardPayload): SignalEntry[] {
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
    const durationSec =
      log.video_duration_sec ?? log.audio_duration_sec ?? message?.duration_sec ?? 0
    const mediaType = (log.media_type || message?.type || 'text').toLowerCase()

    const vocalWarmth = computeVocalWarmth(prosodicSummary)
    const facialTension = computeFacialTension(facialAnalysis, bodyLanguage)
    const bodyActivation = computeBodyActivation(bodyLanguage)
    const incongruence = vocalWarmth >= 65 && facialTension >= 60

    return {
      id: log.id,
      createdAt: log.created_at,
      avatarName,
      avatarImage: resolveAvatarUrl(avatarName),
      contactName: contact?.display_name?.trim() || contact?.email?.trim() || 'Guest',
      transcript,
      behavioralSummary,
      prosodicSummary,
      facialAnalysis,
      bodyLanguage,
      mediaType,
      durationSec,
      vocalWarmth,
      facialTension,
      bodyActivation,
      incongruence,
    }
  })
}

export default function ExtendedPerception() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [entries, setEntries] = useState<SignalEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
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

        const nextEntries = deriveEntries(payload)
        if (!cancelled) {
          setEntries(nextEntries)
          setSelectedId(nextEntries[0]?.id ?? null)
        }
      } catch (loadError) {
        if (!cancelled) {
          const message = loadError instanceof Error ? loadError.message : 'Failed to load extended perception dashboard.'
          setError(message)
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

  const selected = useMemo(() => entries.find((entry) => entry.id === selectedId) ?? entries[0] ?? null, [entries, selectedId])

  const recentSeries = useMemo(() => {
    const sorted = [...entries].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
    return sorted.slice(-24)
  }, [entries])

  const warmthSeries = useMemo(() => recentSeries.map((entry) => entry.vocalWarmth), [recentSeries])
  const tensionSeries = useMemo(() => recentSeries.map((entry) => entry.facialTension), [recentSeries])

  const strongIncongruence = selected?.incongruence ?? false
  const corr = useMemo(() => correlation(recentSeries), [recentSeries])

  return (
    <div className="min-h-[100dvh] bg-[radial-gradient(circle_at_top,rgba(30,190,255,0.18),transparent_34%),radial-gradient(circle_at_88%_14%,rgba(40,214,171,0.14),transparent_28%),linear-gradient(180deg,#020710_0%,#040b16_45%,#050d19_100%)] text-white">
      <div
        className="mx-auto w-full max-w-[1640px] px-4 sm:px-6 lg:px-8"
        style={{
          paddingTop: 'max(1.25rem, env(safe-area-inset-top))',
          paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))',
        }}
      >
        <header className="rounded-[28px] border border-cyan-300/20 bg-[linear-gradient(180deg,rgba(7,18,33,0.95),rgba(4,10,20,0.98))] p-5 shadow-[0_34px_120px_rgba(0,0,0,0.45)] sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.34em] text-cyan-200/65">Extended Perception Dashboard</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-white sm:text-4xl">ORACLE Crossmodal Monitoring</h1>
              <p className="mt-2 max-w-4xl text-sm text-white/64 sm:text-[15px]">
                Real-time comparison of vocal warmth, facial tension, body language activation, and crossmodal incongruence signals from perception logs.
              </p>
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => navigate('/perception')}
                className="rounded-2xl border border-white/14 bg-white/5 px-4 py-2.5 text-sm text-white/80 transition hover:bg-white/10"
              >
                Perception
              </button>
              <button
                type="button"
                onClick={() => navigate('/')}
                className="rounded-2xl border border-cyan-300/30 bg-cyan-400/15 px-4 py-2.5 text-sm text-cyan-100 transition hover:border-cyan-200/60 hover:text-white"
              >
                Home
              </button>
            </div>
          </div>
        </header>

        {loading ? (
          <div className="flex min-h-[40vh] items-center justify-center">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/12 border-t-cyan-300" />
          </div>
        ) : error ? (
          <div className="mt-6 rounded-3xl border border-rose-400/30 bg-rose-500/10 p-5 text-sm text-rose-100">{error}</div>
        ) : entries.length === 0 ? (
          <div className="mt-6 rounded-3xl border border-white/12 bg-white/[0.03] p-6 text-sm text-white/65">
            No perception logs available yet.
          </div>
        ) : (
          <div className="mt-6 grid gap-5 xl:grid-cols-[330px_minmax(0,1fr)]">
            <aside className="rounded-[26px] border border-cyan-300/15 bg-[linear-gradient(180deg,rgba(6,14,26,0.94),rgba(3,8,16,0.98))] p-3 shadow-[0_30px_80px_rgba(0,0,0,0.35)] xl:max-h-[calc(100vh-190px)] xl:overflow-y-auto">
              <div className="px-2 pb-3 pt-1">
                <p className="text-[11px] uppercase tracking-[0.24em] text-cyan-100/45">Signal Feed</p>
                <p className="mt-1 text-xs text-white/52">{entries.length} logs</p>
              </div>
              <div className="space-y-2">
                {entries.map((entry) => {
                  const active = selected?.id === entry.id
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setSelectedId(entry.id)}
                      className={`w-full rounded-[20px] border px-3 py-3 text-left transition ${
                        active
                          ? 'border-cyan-300/45 bg-cyan-400/14 shadow-[0_0_0_1px_rgba(74,222,255,0.12)]'
                          : 'border-white/8 bg-white/[0.03] hover:border-cyan-300/28 hover:bg-white/[0.06]'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <img src={entry.avatarImage} alt={entry.avatarName} className="h-11 w-11 rounded-xl object-cover ring-1 ring-white/10" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <p className="truncate text-sm font-medium text-white">{entry.avatarName}</p>
                            <span className="text-[10px] text-white/42">{formatTime(entry.createdAt)}</span>
                          </div>
                          <p className="mt-1 truncate text-xs text-cyan-100/70">{entry.contactName}</p>
                          <div className="mt-2 flex items-center gap-2 text-[10px]">
                            <span className="rounded-full border border-emerald-300/35 bg-emerald-400/12 px-2 py-0.5 text-emerald-100">
                              Warmth {entry.vocalWarmth}%
                            </span>
                            <span className="rounded-full border border-rose-300/35 bg-rose-400/12 px-2 py-0.5 text-rose-100">
                              Tension {entry.facialTension}%
                            </span>
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
                <section className="grid gap-5 lg:grid-cols-2">
                  <article className="rounded-[26px] border border-cyan-300/22 bg-[linear-gradient(180deg,rgba(8,18,33,0.95),rgba(4,10,19,0.98))] p-5 shadow-[0_24px_90px_rgba(0,0,0,0.35)]">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[11px] uppercase tracking-[0.24em] text-cyan-100/55">Signal Comparison Panel</p>
                      <span className="rounded-full border border-white/12 bg-white/[0.05] px-2.5 py-1 text-[10px] text-white/60">
                        {formatTime(selected.createdAt)}
                      </span>
                    </div>
                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
                      {[
                        { label: 'Vocal Warmth', value: selected.vocalWarmth, gradient: 'from-emerald-300 via-lime-300 to-yellow-300', detail: 'Prosody Audio' },
                        { label: 'Facial Tension', value: selected.facialTension, gradient: 'from-rose-300 via-red-400 to-orange-400', detail: 'Action Units' },
                      ].map((bar) => (
                        <div key={bar.label} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                          <div className="text-xs uppercase tracking-[0.15em] text-white/58">{bar.label}</div>
                          <div className="mt-1 text-[11px] text-white/42">{bar.detail}</div>
                          <div className="mt-4 h-48 rounded-xl border border-white/10 bg-[#040b14] p-3">
                            <div className="flex h-full flex-col items-center justify-end gap-3">
                              <div className="relative h-full w-20 overflow-hidden rounded-[12px] border border-white/15 bg-white/5">
                                <div
                                  className={`absolute bottom-0 left-0 w-full rounded-[10px] bg-gradient-to-t ${bar.gradient} transition-all duration-700`}
                                  style={{ height: `${bar.value}%` }}
                                />
                              </div>
                              <div className="text-2xl font-semibold tracking-[-0.02em] text-white">{bar.value}%</div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </article>

                  <article className="rounded-[26px] border border-cyan-300/22 bg-[linear-gradient(180deg,rgba(8,18,33,0.95),rgba(4,10,19,0.98))] p-5 shadow-[0_24px_90px_rgba(0,0,0,0.35)]">
                    <p className="text-[11px] uppercase tracking-[0.24em] text-cyan-100/55">Crossmodal Engine</p>
                    <div className="mt-4 grid grid-cols-5 items-center gap-2 text-center text-[11px] sm:text-xs">
                      {FLOW_NODES.map((node, index) => (
                        <div key={node} className="relative">
                          <div className={`rounded-xl border px-2 py-3 ${index < 4 ? 'border-cyan-300/35 bg-cyan-400/12 text-cyan-100' : strongIncongruence ? 'border-rose-300/45 bg-rose-400/16 text-rose-100' : 'border-emerald-300/45 bg-emerald-400/14 text-emerald-100'}`}>
                            {node}
                          </div>
                          {index < 4 ? <div className="absolute -right-2 top-1/2 hidden -translate-y-1/2 text-cyan-300/70 sm:block">→</div> : null}
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 rounded-2xl border border-white/10 bg-black/25 p-3 text-sm text-white/76">
                      <div className="grid gap-2 sm:grid-cols-3">
                        <div>
                          <span className="text-[10px] uppercase tracking-[0.18em] text-white/45">Auditory</span>
                          <p className="mt-1 text-cyan-100">Warmth {selected.vocalWarmth}%</p>
                        </div>
                        <div>
                          <span className="text-[10px] uppercase tracking-[0.18em] text-white/45">Facial</span>
                          <p className="mt-1 text-cyan-100">Tension {selected.facialTension}%</p>
                        </div>
                        <div>
                          <span className="text-[10px] uppercase tracking-[0.18em] text-white/45">Body</span>
                          <p className="mt-1 text-cyan-100">Activation {selected.bodyActivation}%</p>
                        </div>
                      </div>
                    </div>
                  </article>
                </section>

                {strongIncongruence ? (
                  <section className="rounded-[24px] border border-rose-300/40 bg-[linear-gradient(90deg,rgba(98,14,28,0.6),rgba(48,7,15,0.82))] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.35)]">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-[11px] uppercase tracking-[0.24em] text-rose-100/75">Incongruence Detection</p>
                        <p className="mt-1 text-lg font-semibold text-rose-100">INCONGRUENCE DETECTED</p>
                        <p className="mt-1 text-sm text-rose-100/72">
                          Vocal warmth ({selected.vocalWarmth}%) is high while facial tension ({selected.facialTension}%) is also high.
                        </p>
                      </div>
                      <span className="rounded-full border border-rose-200/40 bg-rose-500/20 px-3 py-1 text-sm text-rose-100">
                        {new Date(selected.createdAt).toLocaleString()}
                      </span>
                    </div>
                  </section>
                ) : null}

                <section className="grid gap-5 lg:grid-cols-2">
                  <article className="rounded-[26px] border border-cyan-300/22 bg-[linear-gradient(180deg,rgba(8,18,33,0.95),rgba(4,10,19,0.98))] p-5 shadow-[0_24px_90px_rgba(0,0,0,0.35)]">
                    <p className="text-[11px] uppercase tracking-[0.24em] text-cyan-100/55">Signal Correlation Chart</p>
                    <div className="mt-3 grid gap-4 md:grid-cols-2">
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                        <svg viewBox="0 0 340 180" className="h-[180px] w-full">
                          <rect x="0" y="0" width="340" height="180" fill="transparent" />
                          <path d={linePath(warmthSeries, 340, 180)} fill="none" stroke="#6ef2b2" strokeWidth="3" />
                          <path d={linePath(tensionSeries, 340, 180)} fill="none" stroke="#ff6b8a" strokeWidth="2.6" />
                        </svg>
                        <div className="mt-2 flex items-center gap-3 text-[11px] text-white/60">
                          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#6ef2b2]" /> Vocal Warmth</span>
                          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#ff6b8a]" /> Facial Tension</span>
                        </div>
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                        <svg viewBox="0 0 240 180" className="h-[180px] w-full">
                          <rect x="0" y="0" width="240" height="180" fill="transparent" />
                          {recentSeries.map((entry, index) => {
                            const x = (entry.vocalWarmth / 100) * 220 + 10
                            const y = 170 - (entry.facialTension / 100) * 160
                            const isCurrent = entry.id === selected.id
                            return (
                              <circle
                                key={entry.id}
                                cx={x}
                                cy={y}
                                r={isCurrent ? 5.4 : 3.5}
                                fill={isCurrent ? '#9ee7ff' : '#4dc7ff'}
                                opacity={isCurrent ? 1 : clamp(0.32 + index / recentSeries.length, 0.32, 0.9)}
                              />
                            )
                          })}
                        </svg>
                        <p className="mt-2 text-[11px] text-white/60">
                          Correlation coefficient: <span className="text-cyan-100">{corr.toFixed(2)}</span>
                        </p>
                      </div>
                    </div>
                  </article>

                  <article className="rounded-[26px] border border-cyan-300/22 bg-[linear-gradient(180deg,rgba(8,18,33,0.95),rgba(4,10,19,0.98))] p-5 shadow-[0_24px_90px_rgba(0,0,0,0.35)]">
                    <p className="text-[11px] uppercase tracking-[0.24em] text-cyan-100/55">Temporal Alignment</p>
                    <div className="mt-3 space-y-2">
                      {recentSeries.slice(-10).map((entry) => {
                        const simultaneous = entry.vocalWarmth >= 60 && entry.facialTension >= 60
                        return (
                          <div key={entry.id} className="rounded-xl border border-white/10 bg-black/20 p-3">
                            <div className="mb-2 flex items-center justify-between text-[11px] text-white/55">
                              <span>{formatTime(entry.createdAt)}</span>
                              <span>{entry.mediaType.toUpperCase()} • {Math.round(entry.durationSec || 0)}s</span>
                            </div>
                            <div className="space-y-1.5">
                              <div className="h-2 overflow-hidden rounded-full bg-white/8">
                                <div className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-emerald-300" style={{ width: `${entry.vocalWarmth}%` }} />
                              </div>
                              <div className="h-2 overflow-hidden rounded-full bg-white/8">
                                <div className="h-full rounded-full bg-gradient-to-r from-rose-300 to-red-400" style={{ width: `${entry.facialTension}%` }} />
                              </div>
                              <div className={`text-[10px] ${simultaneous ? 'text-rose-200' : 'text-emerald-200'}`}>
                                {simultaneous ? 'Simultaneous high audio + facial event confirmed' : 'Signals not simultaneously elevated'}
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </article>
                </section>

                <section className="rounded-[24px] border border-cyan-300/20 bg-[linear-gradient(180deg,rgba(8,18,33,0.95),rgba(4,10,19,0.98))] p-5">
                  <p className="text-[11px] uppercase tracking-[0.24em] text-cyan-100/55">ORACLE Result Layer</p>
                  <div className="mt-3 grid gap-4 lg:grid-cols-2">
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-white/45">Behavioral Summary (LUCID)</p>
                      <p className="mt-2 text-sm leading-6 text-white/76">
                        {selected.behavioralSummary || 'No behavioral summary available for this log.'}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-white/45">Body Language</p>
                      <p className="mt-2 text-sm leading-6 text-white/76">
                        {normalizeBodyLanguageSummary(selected.bodyLanguage) || 'No body language summary available.'}
                      </p>
                      {selected.transcript ? (
                        <p className="mt-3 line-clamp-3 text-xs leading-5 text-white/52">
                          Transcript anchor: {selected.transcript}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </section>
              </main>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
