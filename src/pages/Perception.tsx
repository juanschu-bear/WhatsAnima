import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { resolveAvatarUrl } from '../lib/avatars'

type LanguageFilter = 'All' | 'English' | 'German' | 'Spanish'
type AnalysisTab = 'voice' | 'video'
type PersistedPerceptionFilters = {
  avatarFilter: string
  languageFilter: LanguageFilter
  analysisTab: AnalysisTab
  emotionFilter: string
  ruleFilter: string
  dateFrom: string
  dateTo: string
}

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
  facial_analysis: Record<string, unknown> | null
  body_language: Record<string, unknown> | null
  media_type: string | null
  video_duration_sec: number | null
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
  firedRules: Array<{ rawName: string; name: string; confidence: number | null; category: string | null; interpretation: string | null }>
  prosodicSummary: Record<string, unknown>
  messageMediaUrl: string | null
  messageDurationSec: number | null
  messageType: string | null
  mediaType: string | null
  facialAnalysis: Record<string, unknown>
  bodyLanguage: Record<string, unknown>
}

interface PerceptionDashboardPayload {
  owners: OwnerRow[]
  contacts: ContactRow[]
  conversations: ConversationRow[]
  messages: MessageRow[]
  logs: PerceptionLogRow[]
}

const LANGUAGE_OPTIONS: LanguageFilter[] = ['All', 'English', 'German', 'Spanish']
const FILTER_STORAGE_KEY = 'wa_perception_filters_v1'

const METRIC_CONFIG = [
  { key: 'speaking_rate_wps', label: 'Speaking Rate', unit: 'wps', reference: 'Normal: 1.5–2.5', accent: 'text-cyan-300', transform: (value: number) => value },
  { key: 'voice_stability', label: 'Voice Stability', unit: '%', reference: 'High >85%, Low <70%', accent: 'text-emerald-300', transform: (value: number) => value * 100 },
  { key: 'voice_tremor', label: 'Voice Tremor', unit: '%', reference: 'Low <10%, High >20%', accent: 'text-amber-300', transform: (value: number) => value * 100 },
  { key: 'pitch_range_hz', label: 'Pitch Range', unit: 'Hz', reference: 'Narrow <50, Wide >100', accent: 'text-fuchsia-300', transform: (value: number) => value },
  { key: 'estimated_fundamental_hz', label: 'Fund. Frequency', unit: 'Hz', reference: 'Male: 85–155', accent: 'text-sky-300', transform: (value: number) => value },
  { key: 'mean_volume_db', label: 'Volume', unit: 'dB', reference: 'Leiser ← -50 · -35 → Lauter', accent: 'text-rose-300', transform: (value: number) => value },
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
  curiosity: { color: 'text-cyan-300', bg: 'bg-cyan-500/12', border: 'border-cyan-400/20', emoji: '🧐' },
  love: { color: 'text-pink-300', bg: 'bg-pink-500/12', border: 'border-pink-400/20', emoji: '❤️' },
  confusion: { color: 'text-purple-300', bg: 'bg-purple-500/12', border: 'border-purple-400/20', emoji: '😵' },
  disappointment: { color: 'text-gray-300', bg: 'bg-gray-500/12', border: 'border-gray-400/20', emoji: '😞' },
  reflective: { color: 'text-indigo-300', bg: 'bg-indigo-500/12', border: 'border-indigo-400/20', emoji: '🤔' },
  surprise: { color: 'text-fuchsia-300', bg: 'bg-fuchsia-500/12', border: 'border-fuchsia-400/20', emoji: '😲' },
  unclassified: { color: 'text-slate-400', bg: 'bg-slate-600/12', border: 'border-slate-600/30', emoji: '—' },
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

const RULE_LABELS: Record<string, string> = {
  high_authenticity_composite: 'Authenticity',
  hesitation_cluster: 'Hesitation',
  emotional_escalation: 'Escalation',
  topic_avoidance_signal: 'Avoidance',
  rehearsed_delivery_pattern: 'Rehearsed',
  vocal_incongruence: 'Incongruence',
  low_authenticity_composite: 'Low Authenticity',
  over_controlled_smoothness: 'Over-Controlled',
  bimodal_emotional_arc: 'Emotional Arc',
}

const RULE_DEFINITIONS: Record<string, string> = {
  high_authenticity_composite: 'Natural vocal variation with low performance pressure - spontaneous, unrehearsed delivery',
  hesitation_cluster: 'Pauses and reformulations cluster in specific moments - localized uncertainty',
  emotional_escalation: 'Voice tremor, pace and volume trend upward together - increasing emotional arousal',
  topic_avoidance_signal: 'Speaking rate drops sharply in one section - possible avoidance around a specific topic',
  rehearsed_delivery_pattern: 'Unusually consistent pitch, rate and volume - delivery sounds practiced rather than spontaneous',
  vocal_incongruence: 'Pitch and speaking rate suggest different emotions - mixed or competing vocal signals',
  low_authenticity_composite: 'High performance layer with constrained spontaneity - guarded delivery',
  over_controlled_smoothness: 'Speech patterns are too even - possible over-regulation of emotional expression',
  bimodal_emotional_arc: 'Stress pattern with temporary mid-segment relief - tension that briefly resolves then returns',
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

function normalizeEmotionValue(value: string | null | undefined) {
  const raw = (value || '').trim()
  if (!raw) return 'Unclassified'
  const lowered = raw.toLowerCase()
  if (lowered === 'neutral' || lowered === 'unknown' || lowered === 'unclassified') return 'Unclassified'
  return titleCase(raw, 'Unclassified')
}

function emotionStyle(value: string) {
  const key = normalizeKey(value)
  if (key === 'neutral' || key === 'unknown' || key === 'unclassified') return EMOTION_STYLES.unclassified
  return EMOTION_STYLES[key] ?? EMOTION_STYLES.unclassified
}

function ruleStyle(value: string) {
  return RULE_STYLES[normalizeKey(value)] ?? { color: 'text-cyan-200', bg: 'bg-cyan-500/10', border: 'border-cyan-400/20' }
}

function ruleLabel(value: string, fallback?: string | null) {
  const key = normalizeKey(value)
  return RULE_LABELS[key] ?? fallback ?? titleCase(value)
}

function normalizeRules(value: unknown): Array<{ rawName: string; name: string; confidence: number | null; category: string | null; interpretation: string | null }> {
  const candidates: unknown[] = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? (() => {
          const obj = value as Record<string, unknown>
          if (Array.isArray(obj.fired_rules)) return obj.fired_rules
          if (obj.session_analysis && typeof obj.session_analysis === 'object') {
            const session = obj.session_analysis as Record<string, unknown>
            const echoRules = session.echo_rules as Record<string, unknown> | undefined
            if (echoRules && Array.isArray(echoRules.fired_rules)) return echoRules.fired_rules
            const crossModalRules = session.cross_modal_rules as Record<string, unknown> | undefined
            if (crossModalRules && Array.isArray(crossModalRules.fired_rules)) return crossModalRules.fired_rules
          }
          return []
        })()
      : typeof value === 'string' && value.trim()
        ? (() => {
            try {
              return normalizeRules(JSON.parse(value))
            } catch {
              return []
            }
          })()
        : []

  return candidates
    .map((item) => {
      if (typeof item === 'string') {
        const rawName = normalizeKey(item)
        return { rawName, name: ruleLabel(rawName), confidence: null, category: null, interpretation: null }
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
              : typeof obj.rule_id === 'string'
                ? obj.rule_id
                : typeof obj.rule_name === 'string'
                  ? obj.rule_name
                  : typeof obj.key === 'string'
                    ? obj.key
              : ''
      ).trim()
      const name = titleCase(
        rawName,
        '',
      )
      if (!name) return null
      const normalizedRawName = normalizeKey(rawName)
      return {
        rawName: normalizedRawName,
        name: ruleLabel(normalizedRawName, name),
        confidence: toNumber(obj.confidence),
        category: typeof obj.category === 'string' ? obj.category : null,
        interpretation: typeof obj.behavioral_interpretation === 'string' ? obj.behavioral_interpretation.trim() || null : null,
      }
    })
    .filter((item): item is { rawName: string; name: string; confidence: number | null; category: string | null; interpretation: string | null } => Boolean(item))
}

function categoryLabel(value: string | null | undefined) {
  const raw = (value || '').trim()
  if (!raw) return 'Uncategorized'
  return titleCase(raw.replace(/_/g, ' '), 'Uncategorized')
}

function loadPersistedFilters(): PersistedPerceptionFilters | null {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedPerceptionFilters>
    return {
      avatarFilter: typeof parsed.avatarFilter === 'string' && parsed.avatarFilter ? parsed.avatarFilter : 'All',
      languageFilter: parsed.languageFilter === 'English' || parsed.languageFilter === 'German' || parsed.languageFilter === 'Spanish' ? parsed.languageFilter : 'All',
      analysisTab: parsed.analysisTab === 'video' ? 'video' : 'voice',
      emotionFilter: typeof parsed.emotionFilter === 'string' && parsed.emotionFilter ? parsed.emotionFilter : 'All',
      ruleFilter: typeof parsed.ruleFilter === 'string' && parsed.ruleFilter ? parsed.ruleFilter : 'All',
      dateFrom: typeof parsed.dateFrom === 'string' ? parsed.dateFrom : '',
      dateTo: typeof parsed.dateTo === 'string' ? parsed.dateTo : '',
    }
  } catch {
    return null
  }
}

function topicAnchor(transcript: string) {
  const cleaned = transcript.replace(/\s+/g, ' ').trim()
  if (!cleaned) return 'what you are circling around'
  const sentence = cleaned.split(/(?<=[.!?])\s+/).find((part) => part.trim().length > 24) || cleaned
  return sentence.replace(/[“”"']/g, '').split(/\s+/).slice(0, 10).join(' ')
}

function looksTechnicalBehavioralSummary(value: string) {
  const lower = value.toLowerCase()
  return (
    /\d/.test(value) ||
    lower.includes('speaking rate') ||
    lower.includes('stability') ||
    lower.includes('tremor') ||
    lower.includes('wps') ||
    lower.includes('points to a clear behavioral pattern') ||
    lower.includes('vocal evidence shows') ||
    lower.includes('grounds the read')
  )
}

function behavioralSummaryDisplay(summary: string, transcript: string, rules: PerceptionEntry['firedRules']) {
  const cleaned = summary.trim()
  if (cleaned && !looksTechnicalBehavioralSummary(cleaned)) return cleaned
  const anchor = topicAnchor(transcript)
  const ruleNames = new Set(rules.map((rule) => rule.rawName))
  if (ruleNames.has('hesitation_cluster')) {
    return `You start tightening up the moment you get close to ${anchor}. That kind of hesitation usually means the real weight is not in the words themselves, but in what becomes true once you say them cleanly.`
  }
  if (ruleNames.has('high_authenticity_composite')) {
    return `There is very little performance in the way you talk about ${anchor}. You sound like someone trying to tell the truth before you have fully decided what that truth is going to cost you.`
  }
  if (ruleNames.has('topic_avoidance_signal')) {
    return `You brush past ${anchor} instead of landing on it. That kind of pullback usually means the pressure sits underneath the topic, not on the surface of it.`
  }
  return `There is a layer of self-management around the way you talk about ${anchor}. You are not empty here; you are controlling how much of yourself actually makes it into the room.`
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

function formatClock(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00'
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function metricValue(entry: PerceptionEntry, metric: typeof METRIC_CONFIG[number]) {
  const raw = toNumber(entry.prosodicSummary[metric.key])
  if (raw == null) return null
  return metric.transform(raw)
}

function firstNumeric(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = toNumber(source[key])
    if (value != null) return value
  }
  return null
}

function pauseBreakdown(entry: PerceptionEntry) {
  const source = entry.prosodicSummary || {}
  const micro = firstNumeric(source, ['micro_pause_count', 'micro_pauses', 'pause_micro_count']) ?? 0
  const notable = firstNumeric(source, ['notable_pause_count', 'notable_pauses', 'pause_notable_count']) ?? 0
  const long = firstNumeric(source, ['long_pause_count', 'long_pauses']) ?? 0
  const deliberate = firstNumeric(source, ['deliberate_pause_count', 'deliberate_pauses']) ?? 0
  const total = firstNumeric(source, ['pause_count', 'total_pause_count', 'pauses_total']) ?? (micro + notable + long + deliberate)
  return { total, micro, notable, long, deliberate }
}

function volumeMeterPercent(value: number | null) {
  if (value == null) return 50
  return Math.max(0, Math.min(100, ((value + 60) / 30) * 100))
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

function PerceptionAudioPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const handleLoadedMetadata = () => {
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0)
    }
    const handleTimeUpdate = () => setCurrentTime(audio.currentTime)
    const handleEnded = () => {
      setIsPlaying(false)
      setCurrentTime(audio.duration || 0)
    }
    const handlePause = () => setIsPlaying(false)
    const handlePlay = () => setIsPlaying(true)

    audio.addEventListener('loadedmetadata', handleLoadedMetadata)
    audio.addEventListener('durationchange', handleLoadedMetadata)
    audio.addEventListener('timeupdate', handleTimeUpdate)
    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('pause', handlePause)
    audio.addEventListener('play', handlePlay)
    audio.load()

    return () => {
      audio.pause()
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata)
      audio.removeEventListener('durationchange', handleLoadedMetadata)
      audio.removeEventListener('timeupdate', handleTimeUpdate)
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('pause', handlePause)
      audio.removeEventListener('play', handlePlay)
    }
  }, [src])

  const togglePlayback = async () => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      await audio.play()
      return
    }
    audio.pause()
  }

  const handleSeek = (event: ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current
    if (!audio) return
    const nextTime = Number(event.target.value)
    audio.currentTime = nextTime
    setCurrentTime(nextTime)
  }

  return (
    <div className="space-y-3">
      <audio ref={audioRef} src={src} preload="metadata" />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void togglePlayback()}
          className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-[#75f0df]/25 bg-[#0c8a6d]/18 text-lg text-[#9af8ea] transition hover:border-[#75f0df]/45 hover:text-white"
        >
          {isPlaying ? '❚❚' : '▶'}
        </button>
        <div className="min-w-0 flex-1">
          <input
            type="range"
            min={0}
            max={duration > 0 ? duration : 0}
            step={0.01}
            value={Math.min(currentTime, duration || currentTime)}
            onChange={handleSeek}
            className="h-2 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-[#74f0df]"
          />
          <div className="mt-2 flex items-center justify-between text-xs text-white/48">
            <span>{formatClock(currentTime)}</span>
            <span>{formatClock(duration)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function topActionUnits(source: Record<string, unknown>) {
  const actionUnits = (source.au_averages || source.action_units || source.au_scores || source.top_action_units) as Record<string, unknown> | undefined
  if (!actionUnits || typeof actionUnits !== 'object') return []
  return Object.entries(actionUnits)
    .map(([name, value]) => ({ name, value: toNumber(value) ?? 0 }))
    .filter((entry) => entry.value > 0)
    .sort((left, right) => right.value - left.value)
    .slice(0, 5)
}

function emotionProfile(source: Record<string, unknown>) {
  const preferredOrder = ['happiness', 'sadness', 'surprise', 'fear', 'anger', 'neutral']
  const map = (
    source.emotion_profile ||
    source.emotion_percentages ||
    source.emotions ||
    source.emotion_distribution
  ) as Record<string, unknown> | undefined
  if (!map || typeof map !== 'object') return []
  const keyed = Object.entries(map).reduce<Record<string, number>>((accumulator, [key, raw]) => {
    const numeric = toNumber(raw)
    if (numeric == null || numeric < 0) return accumulator
    const normalized = normalizeKey(key)
    accumulator[normalized] = numeric > 1 ? numeric : numeric * 100
    return accumulator
  }, {})
  return preferredOrder
    .map((key) => ({ key, value: Math.max(0, Math.min(100, keyed[key] ?? 0)) }))
    .filter((entry) => entry.value > 0)
}

function gazeSummary(source: Record<string, unknown>) {
  return String(
    source.gaze_direction ||
    source.gaze_summary ||
    source.gaze ||
    source.eye_contact_summary ||
    'Unavailable',
  )
}

function bodyLanguageSummary(source: Record<string, unknown>) {
  if (typeof source.summary === 'string' && source.summary.trim()) return source.summary.trim()
  const parts = [
    source.posture_summary || source.posture,
    source.hand_gesture_summary || source.hand_gestures,
    source.movement_summary || source.movement_patterns,
  ]
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
  return parts.length > 0 ? parts.join(' • ') : 'Unavailable'
}

export default function Perception() {
  const navigate = useNavigate()
  const { user } = useAuth()

  const [entries, setEntries] = useState<PerceptionEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const persistedFilters = useMemo(() => loadPersistedFilters(), [])
  const [avatarFilter, setAvatarFilter] = useState(() => persistedFilters?.avatarFilter || 'All')
  const [languageFilter, setLanguageFilter] = useState<LanguageFilter>(() => persistedFilters?.languageFilter || 'All')
  const [analysisTab, setAnalysisTab] = useState<AnalysisTab>(() => persistedFilters?.analysisTab || 'voice')
  const [emotionFilter, setEmotionFilter] = useState(() => persistedFilters?.emotionFilter || 'All')
  const [ruleFilter, setRuleFilter] = useState(() => persistedFilters?.ruleFilter || 'All')
  const [dateFrom, setDateFrom] = useState(() => persistedFilters?.dateFrom || '')
  const [dateTo, setDateTo] = useState(() => persistedFilters?.dateTo || '')

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
          const primaryRules = normalizeRules(log.fired_rules)
          const firedRules = primaryRules.length > 0
            ? primaryRules
            : normalizeRules(log.prosodic_summary)
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
            primaryEmotion: normalizeEmotionValue(log.primary_emotion),
            secondaryEmotion: normalizeEmotionValue(log.secondary_emotion),
            recommendedTone: titleCase(log.recommended_tone, 'Calm, direct'),
            behavioralSummary: behavioralSummaryDisplay((log.behavioral_summary || '').trim(), transcript, firedRules),
            conversationHooks: normalizeHooks(log.conversation_hooks),
            firedRules,
            prosodicSummary: log.prosodic_summary ?? {},
            messageMediaUrl: message?.media_url ?? null,
            messageDurationSec: log.video_duration_sec ?? log.audio_duration_sec ?? message?.duration_sec ?? null,
            messageType: message?.type ?? null,
            mediaType: log.media_type ?? message?.type ?? null,
            facialAnalysis: log.facial_analysis ?? {},
            bodyLanguage: log.body_language ?? {},
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
    () => ['All', ...Array.from(new Set(entries.flatMap((entry) => [entry.primaryEmotion, entry.secondaryEmotion]).filter((emotion) => emotion && emotion !== 'Unclassified'))).sort()],
    [entries],
  )
  const ruleOptions = useMemo(
    () => ['All', ...Array.from(new Set(entries.flatMap((entry) => entry.firedRules.map((rule) => rule.category || rule.name)).filter(Boolean))).sort()],
    [entries],
  )

  useEffect(() => {
    const payload: PersistedPerceptionFilters = {
      avatarFilter,
      languageFilter,
      analysisTab,
      emotionFilter,
      ruleFilter,
      dateFrom,
      dateTo,
    }
    try {
      localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(payload))
    } catch {
      // Ignore storage failures in private mode / blocked storage.
    }
  }, [analysisTab, avatarFilter, dateFrom, dateTo, emotionFilter, languageFilter, ruleFilter])

  useEffect(() => {
    if (avatarFilter !== 'All' && !avatarOptions.includes(avatarFilter)) {
      setAvatarFilter('All')
    }
  }, [avatarFilter, avatarOptions])

  useEffect(() => {
    if (emotionFilter !== 'All' && !emotionOptions.includes(emotionFilter)) {
      setEmotionFilter('All')
    }
  }, [emotionFilter, emotionOptions])

  useEffect(() => {
    if (ruleFilter !== 'All' && !ruleOptions.includes(ruleFilter)) {
      setRuleFilter('All')
    }
  }, [ruleFilter, ruleOptions])

  const filteredEntries = useMemo(() => {
    return entries.filter((entry) => {
      const normalizedMedia = normalizeKey(entry.mediaType || entry.messageType || '')
      if (analysisTab === 'voice' && normalizedMedia !== 'audio' && normalizedMedia !== 'voice') return false
      if (analysisTab === 'video' && normalizedMedia !== 'video') return false
      if (avatarFilter !== 'All' && entry.avatarName !== avatarFilter) return false
      if (languageFilter !== 'All' && entry.language !== languageFilter) return false
      if (emotionFilter !== 'All' && entry.primaryEmotion !== emotionFilter && entry.secondaryEmotion !== emotionFilter) return false
      if (ruleFilter !== 'All' && !entry.firedRules.some((rule) => rule.name === ruleFilter || rule.category === ruleFilter)) return false
      if (!filterDate(entry.createdAt, dateFrom, dateTo)) return false
      return true
    })
  }, [analysisTab, avatarFilter, dateFrom, dateTo, emotionFilter, entries, languageFilter, ruleFilter])

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
    <div className="min-h-[100dvh] overflow-x-hidden bg-[radial-gradient(circle_at_top,rgba(0,195,170,0.12),transparent_30%),radial-gradient(circle_at_82%_18%,rgba(72,137,255,0.12),transparent_24%),linear-gradient(180deg,#04101a_0%,#07111b_55%,#02060b_100%)] text-white">
      <div
        className="mx-auto flex min-h-[100dvh] max-w-[1560px] flex-col px-4 sm:px-6 lg:px-8"
        style={{
          paddingTop: 'max(1.5rem, env(safe-area-inset-top))',
          paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))',
        }}
      >
        <header className="flex flex-col gap-4 rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(9,20,31,0.94),rgba(4,10,18,0.98))] p-5 shadow-[0_30px_120px_rgba(0,0,0,0.35)] sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.35em] text-[#82f8e3]/55">Perception Dashboard</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-white sm:text-4xl">Live Reading Archive</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-white/62 sm:text-[15px]">
                Filter and inspect perception logs across avatars, languages, rules, and time windows.
              </p>
              <div className="mt-4 inline-flex rounded-2xl border border-white/10 bg-[#08111a] p-1.5">
                <button
                  type="button"
                  onClick={() => setAnalysisTab('voice')}
                  className={`rounded-xl px-4 py-2 text-sm font-medium transition ${
                    analysisTab === 'voice'
                      ? 'bg-[#0c8a6d]/30 text-[#9af8ea] shadow-[0_0_0_1px_rgba(116,240,223,0.18)]'
                      : 'text-white/70 hover:bg-white/6 hover:text-white'
                  }`}
                >
                  Voice Analysis
                </button>
                <button
                  type="button"
                  onClick={() => setAnalysisTab('video')}
                  className={`rounded-xl px-4 py-2 text-sm font-medium transition ${
                    analysisTab === 'video'
                      ? 'bg-[#0c8a6d]/30 text-[#9af8ea] shadow-[0_0_0_1px_rgba(116,240,223,0.18)]'
                      : 'text-white/70 hover:bg-white/6 hover:text-white'
                  }`}
                >
                  Video Analysis
                </button>
              </div>
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
          <div className="flex min-h-[30vh] items-center justify-center">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/10 border-t-[#7cf0e1]" />
          </div>
        ) : error ? (
          <div className="mt-6 rounded-[28px] border border-rose-400/20 bg-rose-500/10 p-6 text-sm text-rose-100">
            {error}
          </div>
        ) : (
          <div className="mt-6 grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)] xl:items-start">
            <aside className="rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(8,18,28,0.92),rgba(5,11,18,0.96))] p-3 shadow-[0_30px_90px_rgba(0,0,0,0.3)] xl:sticky xl:top-5 xl:max-h-[calc(100vh-300px)] xl:self-start">
              <div className="flex items-center justify-between px-2 pb-3 pt-1">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.25em] text-white/35">Timeline</p>
                  <p className="mt-1 text-sm text-white/58">{filteredEntries.length} filtered logs</p>
                </div>
              </div>

              <div className="space-y-2 pr-1 max-xl:max-h-[42dvh] max-xl:overflow-y-auto xl:max-h-[calc(100vh-380px)] xl:overflow-y-auto">
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
                        <div className="flex w-11 shrink-0 flex-col items-center pt-0.5 text-center">
                          <span className={`text-[22px] leading-none ${primaryEmotionStyle.color}`}>
                            {primaryEmotionStyle.emoji}
                          </span>
                          <span className="mt-2 rounded-full border border-white/12 bg-white/[0.06] px-2 py-0.5 text-sm font-semibold tracking-[-0.02em] text-white">
                            {durationLabel ?? '—'}
                          </span>
                        </div>
                        <img src={entry.avatarImage} alt={entry.avatarName} className="h-12 w-12 rounded-2xl object-cover ring-1 ring-white/10" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-3">
                            <p className="truncate text-sm font-semibold text-white">{entry.avatarName}</p>
                            <span className="shrink-0 text-[11px] text-white/42">{new Date(entry.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                          </div>
                          <p className="mt-1 text-xs text-[#86f5e5]">{entry.contactName} · {entry.language}</p>
                          <div className="mt-2 flex items-center gap-3">
                            <span className={`rounded-full border px-2.5 py-1 text-[11px] ${primaryEmotionStyle.border} ${primaryEmotionStyle.bg} ${primaryEmotionStyle.color}`}>
                              {primaryEmotionStyle.emoji} {entry.primaryEmotion}
                            </span>
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

            <main className="min-w-0 pr-1">
              {selectedEntry ? (
                <div className="space-y-5">
                  <section className="rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(8,18,28,0.94),rgba(4,10,18,0.98))] p-5 shadow-[0_30px_100px_rgba(0,0,0,0.32)] sm:p-6">
                    <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
                      <div className="flex min-w-0 items-center gap-4 lg:flex-1">
                        <img src={selectedEntry.avatarImage} alt={selectedEntry.avatarName} className="h-16 w-16 rounded-[24px] object-cover ring-1 ring-white/10" />
                        <div className="min-w-0">
                          <p className="text-[11px] uppercase tracking-[0.24em] text-white/35">Selected Log</p>
                          <h2 className="mt-1 truncate text-2xl font-semibold tracking-[-0.03em] text-white">{selectedEntry.avatarName}</h2>
                          <p className="mt-1 truncate text-sm text-white/58">{selectedEntry.contactName} · {new Date(selectedEntry.createdAt).toLocaleString()}</p>
                        </div>
                      </div>
                      <div className="grid w-full gap-3 sm:grid-cols-2 xl:w-auto xl:max-w-[760px] xl:grid-cols-3">
                        {[
                          { label: 'Primary Emotion', value: selectedEntry.primaryEmotion, style: emotionStyle(selectedEntry.primaryEmotion) },
                          { label: 'Secondary Emotion', value: selectedEntry.secondaryEmotion, style: emotionStyle(selectedEntry.secondaryEmotion) },
                          { label: 'Recommended Tone for Avatar', value: selectedEntry.recommendedTone, tone: 'from-[#153428] to-[#0b1712]' },
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

                    {selectedEntry.messageMediaUrl ? (
                      <div className="mt-5 rounded-[24px] border border-white/8 bg-black/20 p-4">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <p className="text-sm font-medium text-white">{selectedEntry.mediaType === 'video' ? 'Video playback' : 'Audio playback'}</p>
                          <p className="text-xs text-white/45">{selectedEntry.messageDurationSec ? formatDuration(selectedEntry.messageDurationSec) : 'Duration unavailable'}</p>
                        </div>
                        {selectedEntry.mediaType === 'video' ? (
                          <video
                            src={selectedEntry.messageMediaUrl}
                            controls
                            playsInline
                            className="max-h-[420px] w-full rounded-[20px] bg-black object-contain"
                          />
                        ) : (
                          <PerceptionAudioPlayer src={selectedEntry.messageMediaUrl} />
                        )}
                      </div>
                    ) : null}
                  </section>

                  {selectedEntry.mediaType === 'video' ? (
                    <section className="grid gap-5 lg:grid-cols-2">
                      <div className="rounded-[28px] border border-fuchsia-400/16 bg-[linear-gradient(180deg,rgba(54,14,41,0.82),rgba(17,7,16,0.96))] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.25)]">
                        <div className="text-[11px] uppercase tracking-[0.24em] text-fuchsia-100/50">CYGNUS Facial Analysis</div>
                        <div className="mt-4 space-y-3">
                          {topActionUnits(selectedEntry.facialAnalysis).length > 0 ? (
                            topActionUnits(selectedEntry.facialAnalysis).map((unit) => (
                              <div key={unit.name} className="rounded-[18px] border border-white/8 bg-white/[0.04] px-4 py-3">
                                <div className="flex items-center justify-between text-sm text-white/86">
                                  <span>{titleCase(unit.name)}</span>
                                  <span className="text-fuchsia-200">{Math.round(unit.value * 100)}%</span>
                                </div>
                                <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                                  <div
                                    className="h-full rounded-full bg-[linear-gradient(90deg,#ff6bd6,#ff9cf3)]"
                                    style={{ width: `${Math.max(5, Math.round(unit.value * 100))}%` }}
                                  />
                                </div>
                              </div>
                            ))
                          ) : (
                            <p className="text-sm text-white/60">No facial action-unit detail recorded for this log.</p>
                          )}
                          <div className="rounded-[18px] border border-white/8 bg-white/[0.04] px-4 py-3 text-sm text-white/78">
                            Gaze direction: {gazeSummary(selectedEntry.facialAnalysis)}
                          </div>
                          <div className="rounded-[18px] border border-white/8 bg-white/[0.04] px-4 py-3 text-sm text-white/78">
                            Head pose: {String(selectedEntry.facialAnalysis.head_pose || selectedEntry.facialAnalysis.pose_summary || 'Unavailable')}
                          </div>
                          <div className="rounded-[18px] border border-white/8 bg-white/[0.04] px-4 py-3 text-sm text-white/78">
                            Micro-expressions: {Array.isArray(selectedEntry.facialAnalysis.micro_expressions) ? `${selectedEntry.facialAnalysis.micro_expressions.length} events` : 'Unavailable'}
                          </div>
                        </div>
                      </div>

                      <div className="rounded-[28px] border border-amber-400/16 bg-[linear-gradient(180deg,rgba(64,37,8,0.86),rgba(19,11,5,0.96))] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.25)]">
                        <div className="text-[11px] uppercase tracking-[0.24em] text-amber-100/50">Body Language</div>
                        <div className="mt-4 space-y-3">
                          <div className="rounded-[18px] border border-white/8 bg-white/[0.04] px-4 py-3 text-sm text-white/78">
                            Posture: {String(selectedEntry.bodyLanguage.posture_score || selectedEntry.bodyLanguage.posture || 'Unavailable')}
                          </div>
                          <div className="rounded-[18px] border border-white/8 bg-white/[0.04] px-4 py-3 text-sm text-white/78">
                            Gesture frequency: {String(selectedEntry.bodyLanguage.gesture_frequency || selectedEntry.bodyLanguage.hand_gestures || 'Unavailable')}
                          </div>
                          <div className="rounded-[18px] border border-white/8 bg-white/[0.04] px-4 py-3 text-sm text-white/78">
                            Movement patterns: {String(selectedEntry.bodyLanguage.movement_patterns || selectedEntry.bodyLanguage.movement_summary || 'Unavailable')}
                          </div>
                          <div className="rounded-[18px] border border-white/8 bg-white/[0.04] px-4 py-3 text-sm leading-6 text-white/78">
                            Summary: {bodyLanguageSummary(selectedEntry.bodyLanguage)}
                          </div>
                        </div>
                      </div>

                      <div className="rounded-[28px] border border-cyan-400/16 bg-[linear-gradient(180deg,rgba(8,51,66,0.86),rgba(5,18,24,0.96))] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.25)] lg:col-span-2">
                        <div className="text-[11px] uppercase tracking-[0.24em] text-cyan-100/50">Emotion Profile</div>
                        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                          {emotionProfile(selectedEntry.facialAnalysis).length > 0 ? (
                            emotionProfile(selectedEntry.facialAnalysis).map((emotion) => (
                              <div key={emotion.key} className="rounded-[18px] border border-white/8 bg-white/[0.04] px-4 py-3">
                                <div className="flex items-center justify-between text-sm text-white/84">
                                  <span>{titleCase(emotion.key)}</span>
                                  <span className="text-cyan-200">{emotion.value.toFixed(1)}%</span>
                                </div>
                                <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                                  <div
                                    className="h-full rounded-full bg-[linear-gradient(90deg,#4dd7ff,#7af0df)]"
                                    style={{ width: `${Math.max(5, Math.round(emotion.value))}%` }}
                                  />
                                </div>
                              </div>
                            ))
                          ) : (
                            <p className="text-sm text-white/62">No emotion profile percentages recorded for this video log.</p>
                          )}
                        </div>
                      </div>
                    </section>
                  ) : null}

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
                          <div key={`${rule.rawName}-${rule.category}`} className={`group relative rounded-[20px] border px-4 py-4 ${ruleStyle(rule.rawName).border} ${ruleStyle(rule.rawName).bg}`}>
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <p className={`text-sm font-semibold ${ruleStyle(rule.rawName).color}`}>{rule.name}</p>
                                <p className="mt-1 text-xs uppercase tracking-[0.18em] text-white/38">{categoryLabel(rule.category)}</p>
                              </div>
                              <div className={`flex h-9 w-9 items-center justify-center rounded-full border text-xs font-semibold ${ruleStyle(rule.rawName).border} ${ruleStyle(rule.rawName).bg} ${ruleStyle(rule.rawName).color}`}>
                                {rule.confidence != null ? `${Math.round(rule.confidence * 100)}` : '—'}
                              </div>
                            </div>
                            <div className="pointer-events-none absolute left-4 top-full z-20 mt-3 hidden w-[min(26rem,calc(100vw-4rem))] rounded-[18px] border border-white/12 bg-[#07111b]/96 p-4 text-left shadow-[0_24px_80px_rgba(0,0,0,0.45)] group-hover:block">
                              <p className={`text-sm font-semibold ${ruleStyle(rule.rawName).color}`}>{rule.name}</p>
                              <p className="mt-2 text-sm leading-6 text-white/78">
                                {RULE_DEFINITIONS[rule.rawName] || 'No static definition available for this rule yet.'}
                              </p>
                              <div className="mt-3 border-t border-white/8 pt-3">
                                <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">Behavioral Interpretation</div>
                                <p className="mt-2 text-sm leading-6 text-white/68">
                                  {rule.interpretation || 'No log-specific behavioral interpretation recorded for this rule.'}
                                </p>
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
                          {metric.key === 'mean_volume_db' ? (
                            <div className="mt-3">
                              <div className="relative h-2 overflow-hidden rounded-full bg-[linear-gradient(90deg,rgba(148,163,184,0.35),rgba(251,113,133,0.65))]">
                                <div
                                  className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border border-white/70 bg-white shadow-[0_0_0_4px_rgba(255,255,255,0.08)]"
                                  style={{ left: `calc(${volumeMeterPercent(metricValue(selectedEntry, metric))}% - 6px)` }}
                                />
                              </div>
                              <div className="mt-2 flex justify-between text-[11px] text-white/38">
                                <span>Leiser</span>
                                <span>Lauter</span>
                              </div>
                            </div>
                          ) : null}
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
                          <div className="mt-2 text-sm text-white/62">
                            {(() => {
                              const pauses = pauseBreakdown(selectedEntry)
                              return `PAUSES: ${Math.round(pauses.total)} total`
                            })()}
                          </div>
                          <div className="mt-1 text-xs text-white/42">
                            {(() => {
                              const pauses = pauseBreakdown(selectedEntry)
                              return `Micro: ${Math.round(pauses.micro)}, Notable: ${Math.round(pauses.notable)}, Long: ${Math.round(pauses.long)}, Deliberate: ${Math.round(pauses.deliberate)}`
                            })()}
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
