import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getConversation, listMessages, listPerceptionLogs, sendMessage, listAllOwners, findContactByEmail, findOrCreateConversation, createContactForOwner } from '../lib/api'
import { resolveAvatarUrl } from '../lib/avatars'
import { t } from '../lib/i18n'
import {
  uploadAudioToStorage, uploadMediaToStorage,
} from '../lib/mediaUtils'
import { useReactions, QUICK_EMOJIS } from '../hooks/useReactions'
import { useReadReceipts } from '../hooks/useReadReceipts'
import { useSessionMemory } from '../hooks/useSessionMemory'
import { useMessageSelection } from '../hooks/useMessageSelection'
import { useVoiceRecording } from '../hooks/useVoiceRecording'
import { useVideoRecording } from '../hooks/useVideoRecording'
import { VideoRecorder } from '../components/VideoRecorder'
import { getVoiceListeningDelay, getVideoWatchingDelay, getAvatarFirstName, VOICE_SEEN_DELAY_MS } from '../lib/voiceDelay'
import {
  playNotificationSound,
  isAppVisible,
  showLocalNotification,
  incrementUnreadBadge,
  clearUnreadBadge,
  subscribeToPush,
  isPushSubscribed,
} from '../lib/notifications'

type MessageType = 'text' | 'voice' | 'video' | 'image' | 'flashcard' | 'quiz' | 'lesson' | 'fillin'

interface Message {
  id: string
  sender: 'contact' | 'avatar'
  type: MessageType
  content: string | null
  media_url: string | null
  videoBlobUrl?: string | null
  isGalleryVideo?: boolean
  videoNeedsRotation?: boolean
  videoRotationScale?: number
  thumbnail_url?: string | null
  poster_url?: string | null
  preview_url?: string | null
  duration_sec: number | null
  created_at: string
  read_at?: string | null
  _pending?: boolean
  _failed?: boolean
  _errorMessage?: string
  _localBlobUrl?: string
  _retryFn?: () => void
}

interface ConversationData {
  id: string
  owner_id: string
  contact_id: string
  wa_owners: {
    id?: string
    display_name: string
    voice_id: string | null
    system_prompt?: string | null
    tavus_replica_id: string | null
    bio?: string | null
    expertise?: string | null
  }
  wa_contacts: { display_name: string }
}

interface CaptionDraft {
  file: File
  previewUrl: string
}
const WAVEFORM_BARS = Array.from({ length: 15 }, (_, index) => index)
const HTTPS_URL_REGEX = /https:\/\/[^\s]+/gi

interface YouTubePreviewItem {
  url: string
  videoId: string
}

function formatClock(totalSeconds: number) {
  const safeSeconds = Number.isFinite(totalSeconds) ? Math.max(0, totalSeconds) : 0
  const minutes = Math.floor(safeSeconds / 60)
  const seconds = Math.floor(safeSeconds % 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function formatMessageTime(dateStr: string) {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function renderMessageTextWithLinks(content: string | null | undefined) {
  const text = content || ''
  if (!text) return ''

  const parts: ReactNode[] = []
  let lastIndex = 0

  const renderBoldText = (input: string, keyPrefix: string) => {
    const nodes: ReactNode[] = []
    let cursor = 0
    const boldRegex = /\*\*(.+?)\*\*/g
    let boldMatch: RegExpExecArray | null
    let localIndex = 0

    while ((boldMatch = boldRegex.exec(input)) !== null) {
      const start = boldMatch.index
      const end = boldRegex.lastIndex
      if (start > cursor) {
        nodes.push(input.slice(cursor, start))
      }
      nodes.push(
        <strong key={`${keyPrefix}-b-${localIndex++}`} className="font-semibold text-white">
          {boldMatch[1]}
        </strong>
      )
      cursor = end
    }

    if (cursor < input.length) {
      nodes.push(input.slice(cursor))
    }

    return nodes.length > 0 ? nodes : [input]
  }

  for (const match of text.matchAll(HTTPS_URL_REGEX)) {
    const rawUrl = match[0]
    const start = match.index ?? -1
    if (start < 0) continue

    if (start > lastIndex) {
      parts.push(...renderBoldText(text.slice(lastIndex, start), `pre-${start}`))
    }

    const trailingMatch = rawUrl.match(/[),.!?;:]+$/)
    const trailing = trailingMatch ? trailingMatch[0] : ''
    const cleanUrl = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl

    if (cleanUrl.length > 'https://'.length) {
      parts.push(
        <a
          key={`${cleanUrl}-${start}`}
          href={cleanUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="underline break-all text-[#9af8ea] hover:text-[#b9fff5]"
          onClick={(event) => event.stopPropagation()}
        >
          {cleanUrl}
        </a>
      )
      if (trailing) parts.push(...renderBoldText(trailing, `trail-${start}`))
    } else {
      parts.push(...renderBoldText(rawUrl, `raw-${start}`))
    }

    lastIndex = start + rawUrl.length
  }

  if (lastIndex < text.length) {
    parts.push(...renderBoldText(text.slice(lastIndex), `post-${lastIndex}`))
  }

  return parts.length > 0 ? parts : text
}

function extractCleanHttpsUrls(content: string | null | undefined): string[] {
  const text = content || ''
  if (!text) return []
  const urls: string[] = []
  for (const match of text.matchAll(HTTPS_URL_REGEX)) {
    const rawUrl = match[0]
    const trailingMatch = rawUrl.match(/[),.!?;:]+$/)
    const trailing = trailingMatch ? trailingMatch[0] : ''
    const cleanUrl = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl
    if (cleanUrl.length > 'https://'.length) urls.push(cleanUrl)
  }
  return urls
}

function parseYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    if (host === 'youtu.be') {
      const shortId = parsed.pathname.replace('/', '').trim()
      return shortId || null
    }
    if (host === 'www.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com') {
      if (parsed.pathname === '/watch') {
        const watchId = parsed.searchParams.get('v')
        return watchId ? watchId.trim() : null
      }
      if (parsed.pathname.startsWith('/shorts/')) {
        const shortId = parsed.pathname.split('/')[2]?.trim()
        return shortId || null
      }
      if (parsed.pathname.startsWith('/embed/')) {
        const embedId = parsed.pathname.split('/')[2]?.trim()
        return embedId || null
      }
    }
    return null
  } catch {
    return null
  }
}

function extractYouTubePreviews(content: string | null | undefined): YouTubePreviewItem[] {
  const urls = extractCleanHttpsUrls(content)
  const seen = new Set<string>()
  const previews: YouTubePreviewItem[] = []
  for (const url of urls) {
    const videoId = parseYouTubeVideoId(url)
    if (!videoId || seen.has(videoId)) continue
    seen.add(videoId)
    previews.push({ url, videoId })
  }
  return previews
}

function dateKey(dateStr: string) {
  const date = new Date(dateStr)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function formatDateSeparator(dateStr: string) {
  const date = new Date(dateStr)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)

  if (dateKey(date.toISOString()) === dateKey(today.toISOString())) {
    const hour = date.getHours()
    const timeOfDay = hour < 6 ? '\u{1F319} Night' : hour < 12 ? '\u{2600}\u{FE0F} Morning' : hour < 17 ? '\u{1F324}\u{FE0F} Afternoon' : hour < 21 ? '\u{1F305} Evening' : '\u{1F319} Night'
    return `Today \u00b7 ${timeOfDay}`
  }
  if (dateKey(date.toISOString()) === dateKey(yesterday.toISOString())) return 'Yesterday'

  return date.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  })
}

function parseProfileItems(value: string | null | undefined) {
  return (value || '')
    .split(/\n|,|;|\|/g)
    .map((item) => item.trim())
    .filter(Boolean)
}

function isPlaceholderContent(message: Message) {
  return ['[Image]', '[Video]', '[Recorded video]', '[Video message]', '[Voice message]', 'Voice note'].includes(
    message.content || ''
  )
}

const PLAYBACK_SPEEDS = [0.75, 1, 1.5, 2] as const

const VoiceMessageBubble = memo(function VoiceMessageBubble({
  isContact,
  message,
  transcript,
  isRead,
}: {
  isContact: boolean
  message: Message
  transcript?: string
  isRead?: boolean
}) {
  const [isTranscriptOpen, setIsTranscriptOpen] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [displaySeconds, setDisplaySeconds] = useState(message.duration_sec ?? 0)
  const [durationSeconds, setDurationSeconds] = useState(message.duration_sec ?? 0)
  const [progress, setProgress] = useState(0)
  const [speedIndex, setSpeedIndex] = useState(1) // default 1x
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const waveformRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setDisplaySeconds(message.duration_sec ?? 0)
    setDurationSeconds(message.duration_sec ?? 0)
  }, [message.duration_sec, message.id])

  useEffect(() => {
    return () => {
      audioRef.current?.pause()
      audioRef.current = null
    }
  }, [])

  const hasPlayableAudio = Boolean(message.media_url)
  const hasTranscript = Boolean(transcript && transcript.trim())
  const currentSpeed = PLAYBACK_SPEEDS[speedIndex]

  function getEffectiveDuration(audio: HTMLAudioElement): number {
    if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration
    if (durationSeconds > 0) return durationSeconds
    return message.duration_sec ?? 0
  }

  function ensureAudio() {
    if (audioRef.current) return audioRef.current
    if (!message.media_url) return null

    const audio = new Audio(message.media_url)
    audio.preload = 'metadata'
    audio.playbackRate = currentSpeed
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDurationSeconds(audio.duration)
        setDisplaySeconds(audio.duration)
      }
    }
    audio.ontimeupdate = () => {
      const dur = getEffectiveDuration(audio)
      if (dur > 0) {
        setDisplaySeconds(audio.currentTime)
        setProgress(audio.currentTime / dur)
      }
    }
    audio.onended = () => {
      setIsPlaying(false)
      setDisplaySeconds(getEffectiveDuration(audio))
      setProgress(0)
    }
    audio.onerror = () => setIsPlaying(false)
    audioRef.current = audio
    return audio
  }

  const togglePlay = async () => {
    const audio = ensureAudio()
    if (!audio) return

    if (audio.paused) {
      audio.playbackRate = currentSpeed
      await audio.play().catch(() => undefined)
      setIsPlaying(true)
    } else {
      audio.pause()
      setIsPlaying(false)
    }
  }

  function cycleSpeed() {
    const nextIndex = (speedIndex + 1) % PLAYBACK_SPEEDS.length
    setSpeedIndex(nextIndex)
    if (audioRef.current) {
      audioRef.current.playbackRate = PLAYBACK_SPEEDS[nextIndex]
    }
  }

  function seekToPosition(event: React.MouseEvent | React.TouchEvent) {
    const audio = ensureAudio()
    if (!audio || !waveformRef.current) return
    const rect = waveformRef.current.getBoundingClientRect()
    const clientX = 'touches' in event ? event.touches[0].clientX : event.clientX
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const dur = getEffectiveDuration(audio)
    if (dur > 0) {
      audio.currentTime = fraction * dur
      setProgress(fraction)
      setDisplaySeconds(audio.currentTime)
    }
  }

  return (
    <div
      className={`relative rounded-[20px] border px-4 py-3 text-sm shadow-[0_2px_8px_rgba(0,0,0,0.12)] ${
        isContact
          ? 'rounded-tr-[6px] border-[#00a884]/15 bg-[#005c4b] text-white'
          : 'rounded-tl-[6px] border-white/[0.06] bg-[#1a2332] text-white'
      }`}
    >
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={togglePlay}
          disabled={!hasPlayableAudio}
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition disabled:opacity-40 ${isContact ? 'bg-[#00a884]/25 text-[#7be3ce]' : 'bg-white/8 text-white/70'}`}
        >
          {isPlaying ? (
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5h3v14H8zm5 0h3v14h-3z" />
            </svg>
          ) : (
            <svg className="h-4 w-4 pl-0.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        {/* Seekable waveform */}
        <div
          ref={waveformRef}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-[3px]"
          onClick={seekToPosition}
          onTouchStart={seekToPosition}
          role="slider"
          aria-valuenow={Math.round(progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          tabIndex={0}
        >
          {WAVEFORM_BARS.map((bar) => {
            const barProgress = (bar + 1) / WAVEFORM_BARS.length
            const heights = [6, 12, 18, 10, 22, 14, 8, 20, 12, 16, 24, 10, 18, 8, 14]
            const isActive = barProgress <= progress
            return (
              <span
                key={bar}
                className={`w-[3px] rounded-full transition-all duration-150 ${
                  isActive
                    ? isContact ? 'bg-[#7be3ce]' : 'bg-[#00d4a1]'
                    : isContact ? 'bg-white/25' : 'bg-white/20'
                }`}
                style={{ height: `${heights[bar]}px` }}
              />
            )
          })}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <span className="text-[11px] tabular-nums text-white/60">{formatClock(isPlaying ? displaySeconds : durationSeconds)}</span>
          {/* Speed toggle */}
          {hasPlayableAudio && (
            <button
              type="button"
              onClick={cycleSpeed}
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums transition ${
                currentSpeed !== 1
                  ? isContact ? 'bg-[#00a884]/30 text-[#7be3ce]' : 'bg-[#00d4a1]/20 text-[#00d4a1]'
                  : 'text-white/40 hover:text-white/60'
              }`}
            >
              {currentSpeed}x
            </button>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        {hasPlayableAudio && (
          <a
            href={message.media_url!}
            download={`voice-${message.id.slice(0, 8)}.webm`}
            className={`inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-white/80 transition hover:border-white/25`}
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V3" />
            </svg>
            Download
          </a>
        )}
        {hasTranscript ? (
          <button
            type="button"
            onClick={() => setIsTranscriptOpen((current) => !current)}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-white/80 transition hover:border-white/25"
          >
            {isTranscriptOpen ? 'Hide transcript' : 'Transcribe'}
          </button>
        ) : null}
      </div>
      {hasTranscript && isTranscriptOpen ? (
        <div className="mt-2 rounded-2xl bg-black/15 px-3 py-2.5 text-[13px] leading-[1.55] text-white/80">
          {transcript!.split(/(?<=[.!?])\s+/).filter(Boolean).map((sentence, i) => (
            <p key={i} className={i > 0 ? 'mt-1.5' : ''}>{sentence}</p>
          ))}
        </div>
      ) : null}
      {message._failed && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[11px] text-red-400">{message._errorMessage || 'Send failed'}</span>
          {message._retryFn && (
            <button
              type="button"
              onClick={message._retryFn}
              className="inline-flex items-center gap-1 rounded-full border border-red-400/30 bg-red-400/10 px-3 py-1 text-[11px] font-medium text-red-300 transition hover:border-red-400/50 hover:bg-red-400/20"
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Resend
            </button>
          )}
        </div>
      )}
      <span className={`mt-1 flex items-center justify-end gap-0.5 text-[10px] ${isContact ? 'text-white/40' : 'text-white/30'}`}>
        {message._pending && (
          <svg className="mr-1 h-3 w-3 animate-spin text-white/40" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
        {formatMessageTime(message.created_at)}
        {isContact && !message._pending && !message._failed && (
          <span className="ml-1.5 inline-flex items-center gap-[3px]">
            <svg className={`h-3.5 w-3.5 transition-colors duration-500 ${isRead ? 'text-[#53bdeb]' : 'text-white/35'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <svg className={`h-4 w-4 transition-colors duration-500 ${isRead ? 'text-[#53bdeb]' : 'text-white/25'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" fill={isRead ? 'currentColor' : 'none'} />
            </svg>
          </span>
        )}
        {message._failed && (
          <svg className="ml-1 h-3.5 w-3.5 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4m0 4h.01" />
          </svg>
        )}
      </span>
    </div>
  )
})

// --- Flashcard / Quiz Bubble ---
interface FlashcardData {
  title: string
  cards: Array<{ q: string; a: string }>
}

function parseFlashcardContent(content: string | null): FlashcardData | null {
  if (!content) return null
  const match = content.match(/```flashcard\s*\n?([\s\S]*?)\n?```/)
  if (!match) return null
  try {
    const data = JSON.parse(match[1])
    if (data.title && Array.isArray(data.cards) && data.cards.length > 0) return data
  } catch {}
  return null
}

const FlashcardBubble = memo(function FlashcardBubble({
  message,
  isRead,
}: {
  message: Message
  isRead: boolean
}) {
  const data = parseFlashcardContent(message.content)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [completed, setCompleted] = useState<Set<number>>(new Set())

  if (!data) return null

  const card = data.cards[currentIndex]
  const total = data.cards.length
  const progress = completed.size

  function handleFlip() {
    setFlipped(!flipped)
  }

  function handleNext() {
    setCompleted((prev) => new Set([...prev, currentIndex]))
    setFlipped(false)
    if (currentIndex < total - 1) {
      setCurrentIndex(currentIndex + 1)
    }
  }

  function handlePrev() {
    if (currentIndex > 0) {
      setFlipped(false)
      setCurrentIndex(currentIndex - 1)
    }
  }

  function handleReset() {
    setCurrentIndex(0)
    setFlipped(false)
    setCompleted(new Set())
  }

  const allDone = progress === total

  return (
    <div className="w-[300px] overflow-hidden rounded-[20px] rounded-tl-[6px] border border-white/[0.06] bg-[#1a2332] shadow-[0_2px_8px_rgba(0,0,0,0.12)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
        <span className="text-[13px] font-medium text-white/80">{data.title}</span>
        <span className="text-[11px] text-white/40">{progress}/{total}</span>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-white/[0.04]">
        <div
          className="h-full bg-[#00a884] transition-all duration-300"
          style={{ width: `${(progress / total) * 100}%` }}
        />
      </div>

      {allDone ? (
        /* Completion state */
        <div className="flex flex-col items-center gap-3 px-4 py-8">
          <span className="text-3xl">{'\u2705'}</span>
          <span className="text-[14px] font-medium text-white/80">All {total} cards done!</span>
          <button
            type="button"
            onClick={handleReset}
            className="rounded-full bg-[#00a884]/20 px-4 py-1.5 text-[12px] font-medium text-[#00a884] transition hover:bg-[#00a884]/30"
          >
            Restart
          </button>
        </div>
      ) : (
        <>
          {/* Card */}
          <button
            type="button"
            onClick={handleFlip}
            className="w-full cursor-pointer px-4 py-6 text-center transition-all duration-200 active:scale-[0.98]"
          >
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-white/30">
              {flipped ? 'Answer' : 'Question'} {currentIndex + 1}/{total}
            </div>
            <div className={`text-[15px] leading-relaxed ${flipped ? 'text-[#00a884]' : 'text-white/90'}`}>
              {flipped ? card.a : card.q}
            </div>
            {!flipped && (
              <div className="mt-3 text-[11px] text-white/25">Tap to reveal answer</div>
            )}
          </button>

          {/* Navigation */}
          <div className="flex items-center justify-between border-t border-white/[0.06] px-3 py-2">
            <button
              type="button"
              onClick={handlePrev}
              disabled={currentIndex === 0}
              className="rounded-full px-3 py-1 text-[12px] text-white/40 transition hover:bg-white/[0.06] hover:text-white/70 disabled:opacity-30"
            >
              {'\u2190'} Prev
            </button>
            <button
              type="button"
              onClick={handleFlip}
              className="rounded-full bg-white/[0.06] px-3 py-1 text-[12px] text-white/60 transition hover:bg-white/10"
            >
              Flip
            </button>
            <button
              type="button"
              onClick={handleNext}
              className="rounded-full px-3 py-1 text-[12px] text-[#00a884] transition hover:bg-[#00a884]/10"
            >
              {currentIndex < total - 1 ? 'Next \u2192' : 'Done \u2713'}
            </button>
          </div>
        </>
      )}

      {/* Timestamp */}
      <div className="flex justify-end px-3 pb-2">
        <span className="text-[10px] text-white/30">
          {new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {isRead && ' \u2713'}
        </span>
      </div>
    </div>
  )
})

// --- Quiz (Multiple Choice) Bubble ---
interface QuizData {
  title: string
  questions: Array<{ q: string; options: string[]; answer: number }>
}

function parseQuizContent(content: string | null): QuizData | null {
  if (!content) return null
  const match = content.match(/```quiz\s*\n?([\s\S]*?)\n?```/)
  if (!match) return null
  try {
    const data = JSON.parse(match[1])
    if (data.title && Array.isArray(data.questions) && data.questions.length > 0) return data
  } catch {}
  return null
}

const QuizBubble = memo(function QuizBubble({
  message,
  isRead,
}: {
  message: Message
  isRead: boolean
}) {
  const data = parseQuizContent(message.content)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [selected, setSelected] = useState<number | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [score, setScore] = useState(0)
  const [finished, setFinished] = useState(false)

  if (!data) return null

  const question = data.questions[currentIndex]
  const total = data.questions.length
  function handleSelect(idx: number) {
    if (confirmed) return
    setSelected(idx)
  }

  function handleConfirm() {
    if (selected === null) return
    setConfirmed(true)
    if (selected === question.answer) setScore((s) => s + 1)
  }

  function handleNext() {
    if (currentIndex < total - 1) {
      setCurrentIndex((i) => i + 1)
      setSelected(null)
      setConfirmed(false)
    } else {
      setFinished(true)
    }
  }

  function handleReset() {
    setCurrentIndex(0)
    setSelected(null)
    setConfirmed(false)
    setScore(0)
    setFinished(false)
  }

  return (
    <div className="w-[300px] overflow-hidden rounded-[20px] rounded-tl-[6px] border border-white/[0.06] bg-[#1a2332] shadow-[0_2px_8px_rgba(0,0,0,0.12)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
        <span className="text-[13px] font-medium text-white/80">{data.title}</span>
        <span className="text-[11px] text-white/40">{currentIndex + 1}/{total}</span>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-white/[0.04]">
        <div
          className="h-full bg-[#00a884] transition-all duration-300"
          style={{ width: `${((currentIndex + (confirmed ? 1 : 0)) / total) * 100}%` }}
        />
      </div>

      {finished ? (
        <div className="flex flex-col items-center gap-3 px-4 py-8">
          <span className="text-3xl">{score === total ? '\u{1F3C6}' : score >= total / 2 ? '\u{1F44D}' : '\u{1F4AA}'}</span>
          <span className="text-[14px] font-medium text-white/80">{score}/{total} correct</span>
          <button
            type="button"
            onClick={handleReset}
            className="rounded-full bg-[#00a884]/20 px-4 py-1.5 text-[12px] font-medium text-[#00a884] transition hover:bg-[#00a884]/30"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {/* Question */}
          <div className="px-4 py-4">
            <div className="mb-3 text-[14px] leading-relaxed text-white/90">{question.q}</div>
            <div className="flex flex-col gap-2">
              {question.options.map((opt, idx) => {
                let style = 'border-white/10 bg-white/[0.04] text-white/70'
                if (confirmed && idx === question.answer) style = 'border-[#00a884]/40 bg-[#00a884]/15 text-[#00a884]'
                else if (confirmed && idx === selected) style = 'border-red-400/40 bg-red-500/15 text-red-300'
                else if (idx === selected) style = 'border-[#00a884]/40 bg-[#00a884]/10 text-white'
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleSelect(idx)}
                    className={`rounded-xl border px-3 py-2.5 text-left text-[13px] transition ${style}`}
                  >
                    <span className="mr-2 font-medium text-white/40">{String.fromCharCode(65 + idx)}</span>
                    {opt}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Action */}
          <div className="flex justify-end border-t border-white/[0.06] px-3 py-2">
            {!confirmed ? (
              <button
                type="button"
                onClick={handleConfirm}
                disabled={selected === null}
                className="rounded-full px-4 py-1.5 text-[12px] font-medium text-[#00a884] transition hover:bg-[#00a884]/10 disabled:opacity-30"
              >
                Check
              </button>
            ) : (
              <button
                type="button"
                onClick={handleNext}
                className="rounded-full px-4 py-1.5 text-[12px] font-medium text-[#00a884] transition hover:bg-[#00a884]/10"
              >
                {currentIndex < total - 1 ? 'Next \u2192' : 'Results'}
              </button>
            )}
          </div>
        </>
      )}

      {/* Timestamp */}
      <div className="flex justify-end px-3 pb-2">
        <span className="text-[10px] text-white/30">
          {new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {isRead && ' \u2713'}
        </span>
      </div>
    </div>
  )
})

// --- Lesson (Course Sections) Bubble ---
interface LessonData {
  title: string
  sections: Array<{ heading: string; body: string }>
}

function parseLessonContent(content: string | null): LessonData | null {
  if (!content) return null
  const match = content.match(/```lesson\s*\n?([\s\S]*?)\n?```/)
  if (!match) return null
  try {
    const data = JSON.parse(match[1])
    if (data.title && Array.isArray(data.sections) && data.sections.length > 0) return data
  } catch {}
  return null
}

const LessonBubble = memo(function LessonBubble({
  message,
  isRead,
}: {
  message: Message
  isRead: boolean
}) {
  const data = parseLessonContent(message.content)
  const [currentSection, setCurrentSection] = useState(0)
  const [maxVisited, setMaxVisited] = useState(0)

  if (!data) return null

  const section = data.sections[currentSection]
  const total = data.sections.length
  const progress = Math.min(maxVisited + 1, total)

  function handleNext() {
    if (currentSection < total - 1) {
      const next = currentSection + 1
      setCurrentSection(next)
      setMaxVisited((m) => Math.max(m, next))
    }
  }

  function handlePrev() {
    if (currentSection > 0) setCurrentSection(currentSection - 1)
  }

  return (
    <div className="w-[300px] overflow-hidden rounded-[20px] rounded-tl-[6px] border border-white/[0.06] bg-[#1a2332] shadow-[0_2px_8px_rgba(0,0,0,0.12)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
        <span className="text-[13px] font-medium text-white/80">{data.title}</span>
        <span className="text-[11px] text-white/40">{currentSection + 1}/{total}</span>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-white/[0.04]">
        <div
          className="h-full bg-[#00a884] transition-all duration-300"
          style={{ width: `${(progress / total) * 100}%` }}
        />
      </div>

      {/* Section content */}
      <div className="px-4 py-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[#00a884]/70">
          {section.heading}
        </div>
        <div className="text-[13.5px] leading-relaxed text-white/80 whitespace-pre-line">
          {section.body}
        </div>
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between border-t border-white/[0.06] px-3 py-2">
        <button
          type="button"
          onClick={handlePrev}
          disabled={currentSection === 0}
          className="rounded-full px-3 py-1 text-[12px] text-white/40 transition hover:bg-white/[0.06] hover:text-white/70 disabled:opacity-30"
        >
          {'\u2190'} Prev
        </button>
        <div className="flex gap-1">
          {data.sections.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setCurrentSection(i)}
              className={`h-1.5 rounded-full transition-all ${
                i === currentSection ? 'w-4 bg-[#00a884]' : i <= maxVisited ? 'w-1.5 bg-[#00a884]/40' : 'w-1.5 bg-white/10'
              }`}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={handleNext}
          disabled={currentSection >= total - 1}
          className="rounded-full px-3 py-1 text-[12px] text-[#00a884] transition hover:bg-[#00a884]/10 disabled:opacity-30"
        >
          Next {'\u2192'}
        </button>
      </div>

      {/* Timestamp */}
      <div className="flex justify-end px-3 pb-2">
        <span className="text-[10px] text-white/30">
          {new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {isRead && ' \u2713'}
        </span>
      </div>
    </div>
  )
})

// --- Fill-in (Lückentext) Bubble ---
interface FillInData {
  title: string
  sentences: Array<{ text: string; blank: string }>
}

function parseFillInContent(content: string | null): FillInData | null {
  if (!content) return null
  const match = content.match(/```fillin\s*\n?([\s\S]*?)\n?```/)
  if (!match) return null
  try {
    const data = JSON.parse(match[1])
    if (data.title && Array.isArray(data.sentences) && data.sentences.length > 0) return data
  } catch {}
  return null
}

const FillInBubble = memo(function FillInBubble({
  message,
  isRead,
}: {
  message: Message
  isRead: boolean
}) {
  const data = parseFillInContent(message.content)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [checked, setChecked] = useState<Record<number, boolean>>({})
  const [finished, setFinished] = useState(false)

  if (!data) return null

  const sentence = data.sentences[currentIndex]
  const total = data.sentences.length
  const correctCount = Object.entries(checked).filter(
    ([i, v]) => v && answers[Number(i)]?.trim().toLowerCase() === data.sentences[Number(i)].blank.toLowerCase()
  ).length

  // Split text around ___
  const parts = sentence.text.split('___')

  function handleCheck() {
    setChecked((c) => ({ ...c, [currentIndex]: true }))
  }

  function handleNext() {
    if (currentIndex < total - 1) {
      setCurrentIndex((i) => i + 1)
    } else {
      setFinished(true)
    }
  }

  function handleReset() {
    setCurrentIndex(0)
    setAnswers({})
    setChecked({})
    setFinished(false)
  }

  const currentAnswer = answers[currentIndex] || ''
  const isChecked = !!checked[currentIndex]
  const isCorrect = isChecked && currentAnswer.trim().toLowerCase() === sentence.blank.toLowerCase()

  return (
    <div className="w-[300px] overflow-hidden rounded-[20px] rounded-tl-[6px] border border-white/[0.06] bg-[#1a2332] shadow-[0_2px_8px_rgba(0,0,0,0.12)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
        <span className="text-[13px] font-medium text-white/80">{data.title}</span>
        <span className="text-[11px] text-white/40">{currentIndex + 1}/{total}</span>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-white/[0.04]">
        <div
          className="h-full bg-[#00a884] transition-all duration-300"
          style={{ width: `${(Object.keys(checked).length / total) * 100}%` }}
        />
      </div>

      {finished ? (
        <div className="flex flex-col items-center gap-3 px-4 py-8">
          <span className="text-3xl">{correctCount === total ? '\u{1F3C6}' : correctCount >= total / 2 ? '\u{1F44D}' : '\u{1F4AA}'}</span>
          <span className="text-[14px] font-medium text-white/80">{correctCount}/{total} correct</span>
          <button
            type="button"
            onClick={handleReset}
            className="rounded-full bg-[#00a884]/20 px-4 py-1.5 text-[12px] font-medium text-[#00a884] transition hover:bg-[#00a884]/30"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {/* Sentence with blank */}
          <div className="px-4 py-5">
            <div className="text-[14px] leading-relaxed text-white/80">
              {parts[0]}
              <span className={`inline-block min-w-[80px] border-b-2 px-1 text-center ${
                isChecked
                  ? isCorrect ? 'border-[#00a884] text-[#00a884]' : 'border-red-400 text-red-300'
                  : 'border-white/30'
              }`}>
                {isChecked ? (
                  <span>{currentAnswer}</span>
                ) : (
                  <input
                    type="text"
                    value={currentAnswer}
                    onChange={(e) => setAnswers((a) => ({ ...a, [currentIndex]: e.target.value }))}
                    className="w-full bg-transparent text-center text-[14px] text-white outline-none placeholder-white/25"
                    placeholder="\u2026"
                    onKeyDown={(e) => { if (e.key === 'Enter' && currentAnswer.trim()) handleCheck() }}
                  />
                )}
              </span>
              {parts[1] || ''}
            </div>

            {/* Feedback */}
            {isChecked && !isCorrect && (
              <div className="mt-3 rounded-xl bg-white/[0.04] px-3 py-2 text-[12px] text-white/50">
                Correct answer: <span className="font-medium text-[#00a884]">{sentence.blank}</span>
              </div>
            )}
          </div>

          {/* Action */}
          <div className="flex justify-end border-t border-white/[0.06] px-3 py-2">
            {!isChecked ? (
              <button
                type="button"
                onClick={handleCheck}
                disabled={!currentAnswer.trim()}
                className="rounded-full px-4 py-1.5 text-[12px] font-medium text-[#00a884] transition hover:bg-[#00a884]/10 disabled:opacity-30"
              >
                Check
              </button>
            ) : (
              <button
                type="button"
                onClick={handleNext}
                className="rounded-full px-4 py-1.5 text-[12px] font-medium text-[#00a884] transition hover:bg-[#00a884]/10"
              >
                {currentIndex < total - 1 ? 'Next \u2192' : 'Results'}
              </button>
            )}
          </div>
        </>
      )}

      {/* Timestamp */}
      <div className="flex justify-end px-3 pb-2">
        <span className="text-[10px] text-white/30">
          {new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {isRead && ' \u2713'}
        </span>
      </div>
    </div>
  )
})

const MediaMessageBubble = memo(function MediaMessageBubble({
  isContact,
  message,
  isRead,
}: {
  isContact: boolean
  message: Message
  isRead?: boolean
}) {
  if (!message.media_url) return null

  const checkmark = isContact ? (
    <span className="ml-1.5 inline-flex items-center gap-[3px]">
      <svg className={`h-3.5 w-3.5 transition-colors duration-500 ${isRead ? 'text-[#53bdeb]' : 'text-white/35'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
      <svg className={`h-4 w-4 transition-colors duration-500 ${isRead ? 'text-[#53bdeb]' : 'text-white/25'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" fill={isRead ? 'currentColor' : 'none'} />
      </svg>
    </span>
  ) : null

  const commonMeta = (
    <span className={`mt-1 flex items-center justify-end gap-0.5 text-[10px] ${isContact ? 'text-white/40' : 'text-white/30'}`}>{formatMessageTime(message.created_at)}{checkmark}</span>
  )

  if (message.type === 'image') {
    return (
      <div
        className={`relative overflow-hidden rounded-[20px] border shadow-[0_2px_8px_rgba(0,0,0,0.12)] ${
          isContact
            ? 'rounded-tr-[6px] border-[#00a884]/15 bg-[#005c4b]'
            : 'rounded-tl-[6px] border-white/[0.06] bg-[#1a2332]'
        }`}
      >
        <img src={message.media_url} alt="Shared image" className="max-h-80 w-full object-cover" />
        {!isPlaceholderContent(message) ? (
          <div className="px-4 pt-2 text-[14px] text-white/90">{message.content}</div>
        ) : null}
        <div className="px-4 pb-2 pt-1">{commonMeta}</div>
      </div>
    )
  }

  return (
    <div
      className={`relative overflow-hidden rounded-[20px] border shadow-[0_2px_8px_rgba(0,0,0,0.12)] ${
        isContact
          ? 'rounded-tr-[6px] border-[#00a884]/15 bg-[#005c4b]'
          : 'rounded-tl-[6px] border-white/[0.06] bg-[#1a2332]'
      }`}
    >
      <img src={message.media_url} alt="Shared image" className="max-h-80 w-full object-cover" />
      {!isPlaceholderContent(message) ? (
        <div className="px-4 pt-2 text-[14px] text-white/90">{message.content}</div>
      ) : null}
      <div className="px-4 pb-2 pt-1">{commonMeta}</div>
    </div>
  )
})

const VideoMessageBubble = memo(function VideoMessageBubble({
  isContact,
  message,
  transcript,
  isRead,
  isProcessing,
}: {
  isContact: boolean
  message: Message
  transcript?: string
  isRead?: boolean
  isProcessing?: boolean
}) {
  const [isTranscriptOpen, setIsTranscriptOpen] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onLoaded = () => {
      if (video.currentTime === 0) video.currentTime = 0.001
    }
    const onEnded = () => setIsPlaying(false)
    const onPause = () => setIsPlaying(false)
    const onPlay = () => setIsPlaying(true)
    video.addEventListener('loadeddata', onLoaded)
    video.addEventListener('ended', onEnded)
    video.addEventListener('pause', onPause)
    video.addEventListener('play', onPlay)
    return () => {
      video.removeEventListener('loadeddata', onLoaded)
      video.removeEventListener('ended', onEnded)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('play', onPlay)
    }
  }, [message.media_url])

  const hasTranscript = Boolean(transcript && transcript.trim())
  const durationSec = Math.max(0, Number(message.duration_sec || 0))
  const durationLabel = durationSec > 0 ? `0:${durationSec < 10 ? '0' : ''}${Math.round(durationSec)}` : ''
  const videoSrc = message.videoBlobUrl || message.media_url || ''
  const hasVideo = Boolean(videoSrc)
  const isGallery = Boolean(message.isGalleryVideo)
  const needsRotation = Boolean(message.videoNeedsRotation)
  const rotationScale = Number(message.videoRotationScale) > 1 ? Number(message.videoRotationScale) : 1.35
  const videoTransform = needsRotation
    ? 'scaleX(-1) rotate(-90deg) scale(' + rotationScale.toFixed(2) + ')'
    : undefined

  const checkmark = isContact ? (
    <span className="ml-1.5 inline-flex items-center gap-[3px]">
      <svg className={`h-3.5 w-3.5 transition-colors duration-500 ${isRead ? 'text-[#53bdeb]' : 'text-white/35'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
      <svg className={`h-4 w-4 transition-colors duration-500 ${isRead ? 'text-[#53bdeb]' : 'text-white/25'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" fill={isRead ? 'currentColor' : 'none'} />
      </svg>
    </span>
  ) : null

  function togglePlay(event: MouseEvent<HTMLDivElement>) {
    event.stopPropagation()
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      video.removeAttribute('muted')
      video.muted = false
      video.loop = false
      void video.play()
    } else {
      video.pause()
    }
  }

  return (
    <div className="relative px-1 py-1">
      <div className="video-bubble">
        {isGallery && hasVideo ? (
          <div className={`video-bubble-rect-container ${isProcessing ? 'processing' : 'processed'}`} onClick={togglePlay}>
            <video ref={videoRef} src={videoSrc} playsInline muted loop preload="metadata" style={videoTransform ? { transform: videoTransform } : undefined} />
            <div className={`video-bubble-play ${isPlaying ? 'hidden' : ''}`}>
              <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3" /></svg>
            </div>
          </div>
        ) : (
          <div className={`video-bubble-circle ${hasVideo && !isGallery ? 'selfie' : ''} ${hasVideo ? '' : 'no-video'} ${isProcessing ? 'processing' : 'processed'}`} onClick={togglePlay}>
            {hasVideo ? (
              <video ref={videoRef} src={videoSrc} playsInline muted loop preload="metadata" style={videoTransform ? { transform: videoTransform } : undefined} />
            ) : (
              <div className="video-bubble-placeholder"><svg viewBox="0 0 24 24" width="32" height="32" fill="rgba(255,255,255,0.6)"><path d="M17 10.5V7a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1v-3.5l4 4v-11l-4 4z" /></svg></div>
            )}
            {hasVideo ? (
              <div className={`video-bubble-play ${isPlaying ? 'hidden' : ''}`}>
                <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3" /></svg>
              </div>
            ) : null}
          </div>
        )}
        <div className="video-bubble-duration">{hasVideo ? durationLabel : 'Video from another device'}</div>
      </div>

      <div className="mt-2 flex items-center gap-2">
        {hasVideo ? (
          <a
            href={videoSrc}
            download={`video-${message.id.slice(0, 8)}.mp4`}
            className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[11px] font-medium transition ${
              isContact
                ? 'border-white/20 bg-black/15 text-white/85 hover:border-white/35'
                : 'border-white/10 bg-white/5 text-white/80 hover:border-white/25'
            }`}
          >
            Download
          </a>
        ) : null}
        {hasTranscript ? (
          <button
            type="button"
            onClick={() => setIsTranscriptOpen((current) => !current)}
            className={`rounded-full border px-3 py-1 text-[11px] font-medium transition ${
              isContact
                ? 'border-white/20 bg-black/15 text-white/85 hover:border-white/35'
                : 'border-white/10 bg-white/5 text-white/80 hover:border-white/25'
            }`}
          >
            {isTranscriptOpen ? 'Hide transcript' : 'Transcribe'}
          </button>
        ) : null}
      </div>

      {hasTranscript && isTranscriptOpen ? (
        <div className="mt-2 rounded-2xl bg-black/15 px-3 py-2.5 text-[13px] leading-[1.55] text-white/80">
          {transcript}
        </div>
      ) : null}

      <span className={`mt-1 flex items-center justify-end gap-0.5 text-[10px] ${isContact ? 'text-white/40' : 'text-white/30'}`}>
        {formatMessageTime(message.created_at)}
        {checkmark}
      </span>
    </div>
  )
})

export default function Chat() {
  const navigate = useNavigate()
  const { conversationId } = useParams<{ conversationId: string }>()
  const [conversation, setConversation] = useState<ConversationData | null>(null)
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false)
  const [profileCardOpen, setProfileCardOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  type AvatarStatus = null | 'listening' | 'watching' | 'looking' | 'thinking' | 'writing' | 'recording' | 'designing'
  const [avatarStatus, setAvatarStatus] = useState<AvatarStatus>(null)
  const [captionDraft, setCaptionDraft] = useState<CaptionDraft | null>(null)
  const [captionText, setCaptionText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [failedMessage, setFailedMessage] = useState<string | null>(null)
  const [transcriptMap, setTranscriptMap] = useState<Record<string, string>>({})
  const [mediaMenuOpen, setMediaMenuOpen] = useState(false)
  const [isDesktopLayout, setIsDesktopLayout] = useState(false)
  const avatarReplyInFlight = useRef(new Set<string>())
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)

  // --- Extracted hooks ---
  const {
    reactionsMap, emojiPickerMessageId, loadReactions,
    addReaction, removeReaction, handleDoubleTap,
    maybeAvatarReact, closeEmojiPicker, toggleReactionPicker,
  } = useReactions()

  const {
    readAtMap, avatarAwayStatus, loadReadAts,
    simulateAvatarRead, markAsInstantlyRead,
  } = useReadReceipts()

  const {
    locale, selectedIds, selectionMode, forwardModalOpen, setForwardModalOpen,
    forwardOwners, setForwardOwners, forwardLoading, setForwardLoading,
    forwardSending, setForwardSending, exportMenuOpen, setExportMenuOpen,
    toastMessage, longPressTimerRef,
    handleMessagePress, handleMessageLongPress, clearSelection,
    getSelectedMessages, handleCopySelected, handleExportAsFile,
    handleExportToClipboard, showToast,
  } = useMessageSelection(messages as any, conversation as any)

  // sendAvatarReply is defined later — use a ref for hooks that need it
  const sendAvatarReplyRef = useRef<(text: string, options?: {
    useVoice?: boolean
    isVoice?: boolean
    isVideo?: boolean
    voiceDurationSec?: number
    videoDurationSec?: number
    perception?: any
    userMessageId?: string
  }) => Promise<boolean>>(async () => false)

  const {
    recordingMode, captureKind,
    recordingSeconds, recordTimerRef,
    speechRecognitionRef, audioStreamRef,
    voiceOverlayOpen, voiceDraftUrl, voiceDraftReady,
    voiceDraftSeconds, voiceDraftTranscript,
    openVoiceOverlay, closeVoiceOverlay, stopVoiceIntoDraft, sendVoiceDraft,
    finishVoiceRecording,
  } = useVoiceRecording({
    conversationId,
    conversation,
    onSending: setSending,
    onError: setError,
    onMessageSent: (msg) => setMessages((current) => [...current, msg as Message]),
    onMessageUpdate: (tempId, updates) => setMessages((current) =>
      current.map((m) => m.id === tempId ? { ...m, ...updates } : m)
    ),
    onTranscript: (id, text) => setTranscriptMap((current) => ({ ...current, [id]: text })),
    sendAvatarReply: (...args) => sendAvatarReplyRef.current(...args),
    simulateAvatarRead,
    maybeAvatarReact,
  })

  const {
    videoOverlayOpen,
    recordingMode: videoRecordingMode,
    recordingSeconds: videoRecordingSeconds,
    progressRingOffset,
    timeWarning,
    videoHint,
    videoStatusText,
    validationText,
    validationType,
    canRecord,
    previewMode,
    previewDuration: videoPreviewDuration,
    previewCurrentTime,
    previewProgress,
    previewPlaying,
    processingStage: videoProcessingStage,
    processingMessageId: videoProcessingMessageId,
    videoPreviewRef,
    openVideoOverlay,
    closeVideoOverlay,
    startVideoRecording,
    stopVideoRecording,
    rotatePreview,
    togglePreviewPlayback,
    seekPreviewToRatio,
    sendVideoBlob,
  } = useVideoRecording({
    conversationId,
    conversation,
    onSending: setSending,
    onError: setError,
    onMessageSent: (msg) => setMessages((current) => [...current, msg as Message]),
    onMessageUpdate: (tempId, updates) => setMessages((current) =>
      current.map((m) => m.id === tempId ? { ...m, ...updates } : m)
    ),
    onTranscript: (id, text) => setTranscriptMap((current) => ({ ...current, [id]: text })),
    sendAvatarReply: (...args) => sendAvatarReplyRef.current(...args),
    simulateAvatarRead,
    maybeAvatarReact,
  })

  useSessionMemory({
    conversationId,
    ownerId: conversation?.owner_id,
    contactId: conversation?.contact_id,
    messages,
    sending,
    avatarStatus,
    conversation,
    sendAvatarReply: (...args) => sendAvatarReplyRef.current(...args),
  })

  async function openForwardModal() {
    setForwardModalOpen(true)
    setForwardLoading(true)
    try {
      const owners = await listAllOwners()
      setForwardOwners(owners as Array<{ id: string; display_name: string }>)
    } catch {
      setForwardOwners([])
    } finally {
      setForwardLoading(false)
    }
  }

  async function forwardToOwner(targetOwnerId: string) {
    if (!conversation || forwardSending) return
    setForwardSending(targetOwnerId)
    try {
      const userEmail = (await (await import('../lib/supabase')).supabase.auth.getUser()).data.user?.email
      if (!userEmail) throw new Error('Not logged in')

      let contact = await findContactByEmail(userEmail)
      if (!contact) {
        contact = await createContactForOwner({
          ownerId: targetOwnerId,
          firstName: '',
          lastName: '',
          email: userEmail,
        })
      }

      const convId = await findOrCreateConversation(targetOwnerId, contact.id)
      const selected = getSelectedMessages()
      const ownerName = conversation.wa_owners.display_name || 'Avatar'
      const contactName = conversation.wa_contacts.display_name || 'You'

      for (const msg of selected) {
        const sourceSpeaker = msg.sender === 'avatar' ? ownerName : contactName
        const forwardedPrefix = `[${t(locale, 'forwardedMessage')} — ${ownerName}]`
        const speakerMeta = `[Source speaker: ${sourceSpeaker}]`

        if (msg.type === 'voice' && msg.media_url) {
          const voiceBody = msg.content && !isPlaceholderContent(msg) ? msg.content : '[Voice message]'
          const voiceContent = `${forwardedPrefix}\n${speakerMeta}\n[Voice]\n${voiceBody}`.trim()
          await sendMessage(
            convId,
            'contact',
            'voice',
            voiceContent,
            msg.media_url,
            msg.duration_sec ?? undefined
          )
          continue
        }

        if (msg.type === 'video' && msg.media_url) {
          const videoBody = msg.content && !isPlaceholderContent(msg) ? msg.content : '[Video message]'
          const videoContent = `${forwardedPrefix}\n${speakerMeta}\n[Video]\n${videoBody}`.trim()
          await sendMessage(
            convId,
            'contact',
            'video',
            videoContent,
            msg.media_url,
            msg.duration_sec ?? undefined
          )
          continue
        }

        if (msg.type === 'image' && msg.media_url) {
          const imageBody = msg.content && !isPlaceholderContent(msg) ? msg.content : '[Image]'
          const imageContent = `${forwardedPrefix}\n${speakerMeta}\n[Image]\n${imageBody}`.trim()
          await sendMessage(
            convId,
            'contact',
            'image',
            imageContent,
            msg.media_url
          )
          continue
        }

        const textContent = `${forwardedPrefix}\n${speakerMeta}\n${msg.content || ''}`.trim()
        await sendMessage(convId, 'contact', 'text', textContent)
      }

      showToast(`${t(locale, 'forward')} ✓`)
      clearSelection()
      setForwardModalOpen(false)
    } catch (err) {
      console.error('Forward failed:', err)
    } finally {
      setForwardSending(null)
    }
  }


  useEffect(() => {
    if (!conversationId) return

    setLoading(true)
    Promise.all([
      getConversation(conversationId),
      listMessages(conversationId),
      listPerceptionLogs(conversationId).catch(() => []),
    ])
      .then(([conv, msgs, logs]) => {
        setConversation(conv as ConversationData)
        setMessages(msgs as Message[])
        const transcripts = (logs as Array<{ message_id: string; transcript: string | null }>).reduce<Record<string, string>>(
          (accumulator, log) => {
            if (log.transcript && !accumulator[log.message_id]) {
              accumulator[log.message_id] = log.transcript
            }
            return accumulator
          },
          {}
        )
        setTranscriptMap(transcripts)
        loadReadAts(msgs as Array<{ id: string; read_at?: string | null }>)
        loadReactions((msgs as Message[]).map((m) => m.id))
      })
      .catch((loadError) => {
        console.error(loadError)
        setError('Unable to load this conversation.')
      })
      .finally(() => setLoading(false))
  }, [conversationId])

  // Auto-prompt for push notifications on first visit
  useEffect(() => {
    if (!conversation) return
    const PUSH_PROMPTED_KEY = 'wa_push_prompted'
    if (localStorage.getItem(PUSH_PROMPTED_KEY)) return
    localStorage.setItem(PUSH_PROMPTED_KEY, '1')
    // Small delay so the UI settles before the browser permission dialog
    const timer = setTimeout(async () => {
      try {
        const already = await isPushSubscribed()
        if (already) return
        const { supabase } = await import('../lib/supabase')
        const { data: { user } } = await supabase.auth.getUser()
        if (user?.id) await subscribeToPush(user.id)
      } catch {}
    }, 2000)
    return () => clearTimeout(timer)
  }, [conversation])

  // Clear badge when user returns to the chat
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') clearUnreadBadge()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, avatarStatus])

  useEffect(() => {
    const closeMenu = () => setMediaMenuOpen(false)
    window.addEventListener('resize', closeMenu)
    return () => window.removeEventListener('resize', closeMenu)
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)')
    const sync = () => setIsDesktopLayout(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    return () => {
      if (recordTimerRef.current) window.clearInterval(recordTimerRef.current)
      audioStreamRef.current?.getTracks().forEach((track) => track.stop())
      speechRecognitionRef.current?.stop?.()
      if (voiceDraftUrl) URL.revokeObjectURL(voiceDraftUrl)
    }
  }, [voiceDraftUrl])

  const groupedTimeline = useMemo(() => {
    const items: Array<{ kind: 'date'; key: string; label: string } | { kind: 'message'; message: Message }> = []
    let lastDate = ''
    for (const message of messages) {
      const currentDate = dateKey(message.created_at)
      if (currentDate !== lastDate) {
        items.push({ kind: 'date', key: currentDate, label: formatDateSeparator(message.created_at) })
        lastDate = currentDate
      }
      items.push({ kind: 'message', message })
    }
    return items
  }, [messages])


  async function getAvatarReply(
    userMessage: string,
    options?: {
      useVoice?: boolean
      imageUrl?: string
      isImage?: boolean
      isVideo?: boolean
      isVoice?: boolean
      perception?: any
      userMessageId?: string
    }
  ): Promise<{ content: string; mediaUrl: string | null; isGeneratedImage?: boolean }> {
    try {
      const {
        useVoice = true,
        imageUrl,
        isImage = false,
        isVideo = false,
        isVoice = false,
        perception,
        userMessageId,
      } = options ?? {}

      const history = messages
        .slice(-10)
        .map((message) => ({
          role: message.sender === 'contact' ? 'user' : 'assistant',
          content: (message.content || '').trim(),
          msgType: message.type as string,
        }))
        .filter((message) => message.content.length > 0)

      setAvatarStatus('writing')
      const chatResponse = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: userMessage,
          conversationId,
          ownerId: conversation?.owner_id || conversation?.wa_owners?.id || null,
          ownerName: conversation?.wa_owners?.display_name || null,
          history,
          image_url: imageUrl,
          isImage,
          isVideo,
          isVoice,
          perception,
          userMessageId,
        }),
      })

      let replyText = ''
      let generatedImageUrl: string | null = null
      const chatData = await chatResponse.json().catch(() => ({}))
      if (chatResponse.ok) {
        replyText = typeof chatData?.content === 'string' ? chatData.content.trim() : ''
        generatedImageUrl = typeof chatData?.image_url === 'string' ? chatData.image_url : null
      } else {
        console.error('[getAvatarReply] Chat API error:', chatData?.error || chatResponse.status)
        throw new Error(`Chat API returned ${chatResponse.status}`)
      }
      // Safety net: strip any generate_image block that leaked through server-side processing
      if (replyText.includes('```generate_image')) {
        replyText = replyText.replace(/```generate_image\s*\n?[\s\S]*?\n?```/g, '').trim()
      }

      if (!replyText && !generatedImageUrl) {
        replyText = 'Honestly? Give me the interesting part first.'
      }

      // If an image was generated, return it directly (no TTS needed for image responses)
      if (generatedImageUrl) {
        return { content: replyText, mediaUrl: generatedImageUrl, isGeneratedImage: true }
      }

      if (!useVoice) {
        return { content: replyText, mediaUrl: null }
      }

      setAvatarStatus('recording')
      const ownerVoiceId = conversation?.wa_owners?.voice_id
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: replyText,
          ...(ownerVoiceId ? { voiceId: ownerVoiceId } : {}),
        }),
      })

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        const ttsError = errData?.error || `TTS HTTP ${response.status}`
        console.error('[getAvatarReply] TTS FAILED:', ttsError)
        // Still return the text so the user gets *something*, but log loudly
        return { content: `[TTS ERROR: ${ttsError}] ${replyText}`, mediaUrl: null }
      }

      const audioBlob = await response.blob()
      if (audioBlob.size === 0) {
        console.error('[getAvatarReply] TTS returned empty audio blob')
        return { content: '[TTS ERROR: empty audio] ' + replyText, mediaUrl: null }
      }
      const uploadedUrl = await uploadAudioToStorage(conversation!, audioBlob, 'audio/mpeg')

      return {
        content: replyText,
        mediaUrl: uploadedUrl,
      }
    } catch (err) {
      console.error('[getAvatarReply] FAILED:', err)
      // Re-throw so sendAvatarReply's catch handles the immersive fallback
      throw err
    }
  }

  async function sendAvatarReply(
    seedText: string,
    options?: {
      useVoice?: boolean
      imageUrl?: string
      isImage?: boolean
      isVideo?: boolean
      isVoice?: boolean
      voiceDurationSec?: number
      videoDurationSec?: number
      perception?: any
      userMessageId?: string
    }
  ) {
    if (!conversationId) return false

    // Guard: prevent duplicate avatar replies for the same user message
    const dedupeKey = options?.userMessageId || seedText
    if (avatarReplyInFlight.current.has(dedupeKey)) {
      console.warn('[sendAvatarReply] Already in-flight for:', dedupeKey)
      return false
    }
    avatarReplyInFlight.current.add(dedupeKey)

    let replySucceeded = false
    // Set initial status based on context
    if (options?.isVoice) setAvatarStatus('listening')
    else if (options?.isVideo) setAvatarStatus('watching')
    else if (options?.isImage) setAvatarStatus('looking')
    else setAvatarStatus('thinking')

    try {
      const useVoice = options?.useVoice ?? true

      // --- Realistic voice-message delay ---
      // Phase 1: "seen" delay (avatar notices the message)
      // Phase 2: "listening" (avatar listens proportional to message length)
      // Phase 3: "thinking" → proceeds with reply generation
      if (options?.isVoice && options.voiceDurationSec) {
        // Phase 1: brief "seen" pause before listening indicator
        await new Promise((r) => setTimeout(r, VOICE_SEEN_DELAY_MS))
        setAvatarStatus('listening')

        // Phase 2: listen for a realistic duration scaled to message length
        const listeningMs = getVoiceListeningDelay(options.voiceDurationSec)
        await new Promise((r) => setTimeout(r, listeningMs))
      }

      // --- Realistic video-message delay ---
      if (options?.isVideo && options.videoDurationSec) {
        await new Promise((r) => setTimeout(r, VOICE_SEEN_DELAY_MS))
        setAvatarStatus('watching')

        const watchingMs = getVideoWatchingDelay(options.videoDurationSec)
        await new Promise((r) => setTimeout(r, watchingMs))
      }

      setAvatarStatus('thinking')

      // Detect image-generation intent early so status shows 'designing' during the API call
      const imageKeywords = /\b(generate|create|draw|make|design|paint|sketch|render|erstell|generiere|zeichne|mal mir|crea|genera|dib[uú]ja|hazme|diseña)\b.*\b(image|picture|photo|illustration|art|bild|foto|imagen|dibujo|ilustraci[oó]n)\b|\b(image|picture|photo|illustration|bild|foto|imagen|dibujo)\b.*\b(generate|create|draw|make|erstell|generiere|zeichne|crea|genera|dib[uú]ja|hazme)\b/i
      if (imageKeywords.test(seedText)) {
        setAvatarStatus('designing')
      }

      const replyPayload = await getAvatarReply(seedText, { ...options, userMessageId: options?.userMessageId })

      // Handle generated image responses
      if (replyPayload.isGeneratedImage && replyPayload.mediaUrl) {
        setAvatarStatus('designing')
        if (replyPayload.content) {
          const textReply = await sendMessage(conversationId, 'avatar', 'text', replyPayload.content)
          setMessages((current) => [...current, textReply as Message])
          markAsInstantlyRead(String((textReply as Message).id))
        }
        const imageReply = await sendMessage(conversationId, 'avatar', 'image', '', replyPayload.mediaUrl)
        setMessages((current) => [...current, imageReply as Message])
        markAsInstantlyRead(String((imageReply as Message).id))
        replySucceeded = true

        // ── Notification for image reply ──
        playNotificationSound()
        if (!isAppVisible()) {
          const avatarName = conversation?.wa_owners?.display_name || 'Avatar'
          showLocalNotification(avatarName, 'Sent an image', conversationId)
          incrementUnreadBadge()
        }
        return replySucceeded
      }

      // Detect special response types (flashcard, quiz, lesson, fillin)
      const specialMatch = replyPayload.content.match(/```(flashcard|quiz|lesson|fillin)\s*\n?[\s\S]*?\n?```/)
      const specialType = specialMatch ? specialMatch[1] as MessageType : null
      const hasAudio = !specialType && useVoice && !!replyPayload.mediaUrl
      const msgType = specialType ?? (hasAudio ? 'voice' : 'text') as MessageType
      const reply = await sendMessage(
        conversationId,
        'avatar',
        msgType,
        replyPayload.content,
        hasAudio ? replyPayload.mediaUrl ?? undefined : undefined
      )
      setMessages((current) => [...current, reply as Message])
      if (hasAudio) {
        setTranscriptMap((current) => ({
          ...current,
          [String((reply as Message).id)]: String(replyPayload.content),
        }))
      }
      // Mark avatar reply as instantly read by contact
      markAsInstantlyRead(String((reply as Message).id))
      replySucceeded = true

      // ── Notification: sound + push/local notification ──
      playNotificationSound()
      if (!isAppVisible()) {
        const avatarName = conversation?.wa_owners?.display_name || 'Avatar'
        const preview = typeof replyPayload.content === 'string'
          ? replyPayload.content.slice(0, 100)
          : 'New message'
        showLocalNotification(avatarName, preview, conversationId)
        incrementUnreadBadge()
      }
    } catch (err) {
      console.error('Avatar reply failed:', err)
      // Send an immersive fallback — never show technical errors
      if (conversationId) {
        try {
          const name = getAvatarFirstName(conversation?.wa_owners?.display_name)
          const excuses = [
            `${name} is in a meeting right now. Back in a sec!`,
            `${name} just stepped out for a coffee. One moment!`,
            `${name} is on the phone. Back in a sec!`,
            `${name} is taking a quick break. Hang tight!`,
            `${name} got distracted for a second. Back shortly!`,
            `${name} is dealing with something real quick. Back in a moment!`,
          ]
          const excuse = excuses[Math.floor(Math.random() * excuses.length)]
          const fallback = await sendMessage(conversationId, 'avatar', 'text', excuse)
          setMessages((current) => [...current, fallback as Message])
        } catch (fallbackErr) {
          console.error('Fallback message also failed:', fallbackErr)
        }
      }
    } finally {
      setAvatarStatus(null)
      avatarReplyInFlight.current.delete(dedupeKey)
    }
    return replySucceeded
  }

  // Keep ref in sync for useSessionMemory's nudge callback
  sendAvatarReplyRef.current = sendAvatarReply

  async function handleSendText(retryContent?: string) {
    const content = retryContent || text.trim()
    if (!content || !conversationId || sending) return
    if (!retryContent) setText('')
    setSending(true)
    setError(null)
    setFailedMessage(null)

    try {
      const message = await sendMessage(conversationId, 'contact', 'text', content)
      setMessages((current) => [...current, message as Message])
      simulateAvatarRead((message as Message).id)
      const replied = await sendAvatarReply(content, { useVoice: false, userMessageId: String((message as Message).id) })
      if (replied) maybeAvatarReact((message as Message).id)
    } catch (sendError: any) {
      console.error(sendError)
      setError(sendError?.message || 'Unable to send your message.')
      setFailedMessage(content)
    } finally {
      setSending(false)
    }
  }

  function openCaptionDraft(file: File) {
    const previewUrl = URL.createObjectURL(file)
    setMediaMenuOpen(false)
    setCaptionText('')
    setCaptionDraft((current) => {
      if (current) URL.revokeObjectURL(current.previewUrl)
      return { file, previewUrl }
    })
  }

  function closeCaptionDraft() {
    setCaptionDraft((current) => {
      if (current) URL.revokeObjectURL(current.previewUrl)
      return null
    })
    setCaptionText('')
  }

  async function sendImageDraft() {
    if (!captionDraft || !conversationId) return

    const { file } = captionDraft
    const caption = captionText.trim()
    closeCaptionDraft()
    setSending(true)
    setError(null)

    try {
      setAvatarStatus('looking')
      const mediaUrl = await uploadMediaToStorage(conversation!, file)
      if (!mediaUrl) throw new Error('upload failed')
      const message = await sendMessage(conversationId, 'contact', 'image', caption || '[Image]', mediaUrl)
      setMessages((current) => [...current, message as Message])
      simulateAvatarRead((message as Message).id)
      const imgReplied = await sendAvatarReply(caption || 'The user shared this image.', {
        useVoice: true,
        imageUrl: mediaUrl,
        isImage: true,
        userMessageId: String((message as Message).id),
      })
      if (imgReplied) maybeAvatarReact((message as Message).id)
    } catch (draftError: any) {
      console.error(draftError)
      setError(draftError?.message || 'Unable to send this image.')
      setAvatarStatus(null)
    } finally {
      setSending(false)
    }
  }

  function handleImageSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('Please choose an image file.')
      return
    }
    openCaptionDraft(file)
  }

  async function handleVideoRecordButton() {
    if (videoRecordingMode === 'recording') {
      await stopVideoRecording()
      return
    }
    await startVideoRecording()
  }

  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-[#0b141a]">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-emerald-500 border-t-transparent" />
      </div>
    )
  }

  if (!conversation) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center bg-[#0b141a] px-4 text-center">
        <p className="text-lg text-white/60">Conversation not found.</p>
      </div>
    )
  }

  const owner = conversation.wa_owners
  const profileSummary = (owner.bio || owner.expertise || '').trim()
  const expertiseItems = parseProfileItems(owner.expertise)
  const mainTopics = expertiseItems.slice(0, 5)
  const strengths = expertiseItems.slice(5, 10).length > 0 ? expertiseItems.slice(5, 10) : expertiseItems.slice(0, 4)

  return (
    <div className="relative flex h-[100dvh] min-h-[100dvh] flex-col overflow-hidden bg-[linear-gradient(140deg,_#020a12_0%,_#071420_35%,_#060e1a_65%,_#030810_100%)] text-white supports-[-webkit-touch-callout:none]:min-h-[-webkit-fill-available]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(0,168,132,0.12),transparent_60%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_40%_at_80%_20%,rgba(56,169,255,0.07),transparent_50%)]" />
      {isDesktopLayout && <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(126,255,234,0.015)_1px,transparent_1px),linear-gradient(90deg,rgba(126,255,234,0.015)_1px,transparent_1px)] bg-[size:40px_40px]" />}
      <div className={`relative z-10 flex min-h-0 flex-1 flex-col ${isDesktopLayout ? 'mx-auto my-6 w-[min(900px,calc(100vw-80px))] overflow-hidden rounded-[28px] border border-white/[0.06] bg-[rgba(6,14,22,0.88)] shadow-[0_40px_160px_rgba(0,0,0,0.55),0_0_0_1px_rgba(255,255,255,0.03)] backdrop-blur-3xl' : ''}`}>
      <header className={`relative z-10 flex items-center gap-3 border-b border-white/[0.06] px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-2xl ${isDesktopLayout ? 'bg-[rgba(8,18,28,0.65)] shadow-[0_1px_0_rgba(255,255,255,0.03)]' : 'bg-[#0a1420]/80 shadow-[0_8px_32px_rgba(0,0,0,0.2)]'}`}>
        {selectionMode ? (
          <>
            <button type="button" onClick={clearSelection} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white/70 transition hover:bg-white/8 hover:text-white">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
            <span className="min-w-0 flex-1 text-base font-semibold text-white">{selectedIds.size} {t(locale, 'selectedCount')}</span>
            {/* Copy */}
            <button type="button" onClick={() => void handleCopySelected()} title={t(locale, 'copyText')} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[#9af8ea] transition hover:bg-white/8">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
            </button>
            {/* Forward */}
            <button type="button" onClick={() => void openForwardModal()} title={t(locale, 'forward')} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[#9af8ea] transition hover:bg-white/8">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 12h15" /></svg>
            </button>
            {/* Export */}
            <div className="relative">
              <button type="button" onClick={() => setExportMenuOpen((c) => !c)} title={t(locale, 'exportChat')} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[#9af8ea] transition hover:bg-white/8">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" /></svg>
              </button>
              {exportMenuOpen && (
                <div className="absolute right-0 top-12 z-50 w-56 rounded-2xl border border-white/10 bg-[linear-gradient(180deg,rgba(17,29,44,0.98),rgba(10,20,33,0.99))] p-2 shadow-[0_24px_80px_rgba(0,0,0,0.4)] backdrop-blur-2xl">
                  <button type="button" onClick={() => void handleExportToClipboard()} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-white/88 transition hover:bg-white/6">
                    <svg className="h-4 w-4 text-[#9af8ea]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                    {t(locale, 'exportToClipboard')}
                  </button>
                  <button type="button" onClick={handleExportAsFile} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-white/88 transition hover:bg-white/6">
                    <svg className="h-4 w-4 text-[#9af8ea]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" /></svg>
                    {t(locale, 'exportAsText')}
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setProfileCardOpen(true)}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left transition hover:bg-white/5"
            >
              <div className="relative shrink-0">
                <img src={resolveAvatarUrl(owner.display_name)} alt={owner.display_name} className="h-10 w-10 shrink-0 rounded-full object-cover ring-1 ring-white/10" />
                <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[#0a1420] bg-[#00d4a1]" />
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-white">{owner.display_name}</h1>
                <p className="text-xs text-[#00d4a1]/80">{avatarStatus ? 'online' : 'online'}</p>
              </div>
            </button>
            {/* Video call */}
            <button
              type="button"
              onClick={() => navigate(`/video-call/${conversation.id}`)}
              className="flex h-11 w-11 items-center justify-center rounded-full border border-[#74f0df]/25 bg-[linear-gradient(180deg,rgba(12,136,109,0.34),rgba(7,76,79,0.42))] text-[#9af8ea] shadow-[0_0_30px_rgba(48,214,193,0.18)] transition hover:border-[#74f0df]/50 hover:text-white disabled:opacity-50"
              title="Start live video call"
            >
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M17 10.5V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-3.5l4 4v-11l-4 4z" />
              </svg>
            </button>
            {/* Three-dot menu */}
            <div className="relative">
              <button type="button" onClick={() => { setHeaderMenuOpen((c) => !c); setExportMenuOpen(false) }} className="flex h-11 w-11 items-center justify-center rounded-full border border-white/8 bg-white/[0.04] text-white/70 transition hover:border-white/15 hover:text-white">
                <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" /></svg>
              </button>
              {headerMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setHeaderMenuOpen(false)} />
                  <div className="absolute right-0 top-14 z-50 w-56 rounded-2xl border border-white/10 bg-[linear-gradient(180deg,rgba(17,29,44,0.98),rgba(10,20,33,0.99))] p-2 shadow-[0_24px_80px_rgba(0,0,0,0.4)] backdrop-blur-2xl">
                    <button type="button" onClick={() => { setHeaderMenuOpen(false); navigate('/avatars') }} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-white/88 transition hover:bg-white/6">
                      <svg className="h-4 w-4 text-[#9af8ea]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
                      {t(locale, 'back')}
                    </button>
                    <button type="button" onClick={() => { setHeaderMenuOpen(false); navigate('/') }} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-white/88 transition hover:bg-white/6">
                      <svg className="h-4 w-4 text-[#9af8ea]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z" /></svg>
                      Home
                    </button>
                    <button type="button" onClick={() => { setHeaderMenuOpen(false); navigate('/settings') }} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-white/88 transition hover:bg-white/6">
                      <svg className="h-4 w-4 text-[#9af8ea]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.573-1.066z" /><circle cx="12" cy="12" r="3" /></svg>
                      {t(locale, 'settings')}
                    </button>
                    <button type="button" onClick={() => { setHeaderMenuOpen(false); navigate('/perception') }} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-white/88 transition hover:bg-white/6">
                      <svg className="h-4 w-4 text-[#9af8ea]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 13h8V3H3v10zm10 8h8V3h-8v18zm-10 0h8v-6H3v6z" /></svg>
                      Perception
                    </button>
                    <div className="my-1 border-t border-white/6" />
                    <button type="button" onClick={() => { setHeaderMenuOpen(false); void handleExportToClipboard() }} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-white/88 transition hover:bg-white/6">
                      <svg className="h-4 w-4 text-[#9af8ea]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                      {t(locale, 'exportToClipboard')}
                    </button>
                    <button type="button" onClick={() => { setHeaderMenuOpen(false); handleExportAsFile() }} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-white/88 transition hover:bg-white/6">
                      <svg className="h-4 w-4 text-[#9af8ea]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" /></svg>
                      {t(locale, 'exportAsText')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </header>

      <main
        className="relative z-0 min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 pb-6"
        onClick={() => closeEmojiPicker()}
      >
        <div className={`mx-auto flex w-full flex-col gap-2.5 ${isDesktopLayout ? 'max-w-[680px] py-5' : 'max-w-2xl'}`}>
          {groupedTimeline.map((item) => {
            if (item.kind === 'date') {
              return (
                <div key={item.key} className="my-3 flex justify-center">
                  <span className="rounded-full border border-white/[0.06] bg-[#182533]/90 px-3.5 py-1 text-[11px] font-medium tracking-wide text-white/50 shadow-[0_2px_8px_rgba(0,0,0,0.15)]">
                    {item.label}
                  </span>
                </div>
              )
            }

            const message = item.message
            const isContact = message.sender === 'contact'
            const isSelected = selectedIds.has(message.id)
	            const reactions = reactionsMap[message.id]
	            const hasReaction = reactions?.contact || reactions?.avatar
	            const isRead = Boolean(readAtMap[message.id])
	            const youtubePreviews = extractYouTubePreviews(message.content)

            // Read receipt: single check (sent) + eye icon (grey=unread, colored=read)
            const ReadReceipt = isContact ? (
              <span className="ml-1.5 inline-flex items-center gap-[3px]">
                {/* Single checkmark = sent */}
                <svg className={`h-3.5 w-3.5 transition-colors duration-500 ${isRead ? 'text-[#53bdeb]' : 'text-white/35'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                {/* Eye icon = seen status */}
                <svg className={`h-4 w-4 transition-colors duration-500 ${isRead ? 'text-[#53bdeb]' : 'text-white/25'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" fill={isRead ? 'currentColor' : 'none'} />
                </svg>
              </span>
            ) : null

            return (
              <div
                key={message.id}
                className={`relative flex transition-colors ${isContact ? 'justify-end' : 'justify-start'} ${isSelected ? 'rounded-2xl bg-[#00a884]/10' : ''} ${hasReaction ? 'mb-4' : ''}`}
                onClick={() => { handleMessagePress(message.id); handleDoubleTap(message.id, selectionMode) }}
                onDoubleClick={() => { if (!selectionMode) toggleReactionPicker(message.id) }}
                onContextMenu={(e) => { e.preventDefault(); handleMessageLongPress(message.id) }}
                onTouchStart={() => {
                  longPressTimerRef.current = window.setTimeout(() => handleMessageLongPress(message.id), 500)
                }}
                onTouchEnd={() => { if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null } }}
                onTouchMove={() => { if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null } }}
              >
                {selectionMode && (
                  <div className="flex items-center px-1">
                    <div className={`flex h-5 w-5 items-center justify-center rounded-full border-2 transition ${isSelected ? 'border-[#00a884] bg-[#00a884]' : 'border-white/30'}`}>
                      {isSelected && <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                    </div>
                  </div>
                )}
                <div className="relative max-w-[78%]">
                  {message.type === 'voice' ? (
                    <VoiceMessageBubble
                      isContact={isContact}
                      message={message}
                      transcript={transcriptMap[message.id] || (!isPlaceholderContent(message) ? message.content || '' : '')}
                      isRead={isRead}
                    />
                  ) : message.type === 'flashcard' ? (
                    <FlashcardBubble message={message} isRead={isRead} />
                  ) : message.type === 'quiz' ? (
                    <QuizBubble message={message} isRead={isRead} />
                  ) : message.type === 'lesson' ? (
                    <LessonBubble message={message} isRead={isRead} />
                  ) : message.type === 'fillin' ? (
                    <FillInBubble message={message} isRead={isRead} />
                  ) : message.type === 'video' ? (
                    <VideoMessageBubble
                      isContact={isContact}
                      message={message}
                      transcript={transcriptMap[message.id] || (!isPlaceholderContent(message) ? message.content || '' : '')}
                      isRead={isRead}
                      isProcessing={Boolean(message._pending && videoProcessingMessageId && videoProcessingMessageId === message.id)}
                    />
                  ) : message.type === 'image' ? (
                    <MediaMessageBubble
                      isContact={isContact}
                      message={message}
                      isRead={isRead}
                    />
                  ) : (
                    <div
                      className={`relative rounded-[20px] border px-4 py-3 text-[14.5px] leading-relaxed shadow-[0_2px_8px_rgba(0,0,0,0.12)] ${
                        isContact
                          ? 'rounded-tr-[6px] border-[#00a884]/15 bg-[#005c4b] text-white'
                          : 'rounded-tl-[6px] border-white/[0.06] bg-[#1a2332] text-white/[0.92]'
                      }`}
                    >
                      <span className="whitespace-pre-wrap break-words">{renderMessageTextWithLinks(message.content)}</span>
                      {youtubePreviews.length > 0 && (
                        <div className="mt-3 space-y-2">
                          {youtubePreviews.map((preview) => (
                            <a
                              key={`${message.id}-${preview.videoId}`}
                              href={preview.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(event) => event.stopPropagation()}
                              className="block overflow-hidden rounded-xl border border-white/12 bg-black/20 transition hover:border-[#00a884]/45"
                            >
                              <img
                                src={`https://img.youtube.com/vi/${preview.videoId}/hqdefault.jpg`}
                                alt="YouTube preview"
                                className="h-auto w-full object-cover"
                                loading="lazy"
                              />
                              <div className="px-3 py-2 text-[12px] text-[#9af8ea]">Open YouTube video</div>
                            </a>
                          ))}
                        </div>
                      )}
	                      <span className={`mt-1 flex items-center justify-end gap-0.5 text-[10px] ${isContact ? 'text-white/40' : 'text-white/30'}`}>
                        {formatMessageTime(message.created_at)}
                        {ReadReceipt}
                      </span>
                    </div>
                  )}
                  {/* Reaction badges */}
                  {hasReaction && (
                    <div className={`absolute -bottom-3.5 flex gap-1 ${isContact ? 'right-2' : 'left-2'}`}>
                      {reactions?.avatar && (
                        <span className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-[#1a2332] text-[18px] shadow-md">{reactions.avatar}</span>
                      )}
                      {reactions?.contact && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); removeReaction(message.id) }}
                          className="flex h-7 w-7 items-center justify-center rounded-full border border-[#00a884]/30 bg-[#005c4b] text-[18px] shadow-md transition hover:border-[#00a884]/50 hover:scale-110"
                        >{reactions.contact}</button>
                      )}
                    </div>
                  )}
                  {/* Emoji picker */}
                  {emojiPickerMessageId === message.id && (
                    <div className={`absolute -top-10 z-30 flex gap-1 rounded-full border border-white/10 bg-[#1e2d3d] px-2 py-1.5 shadow-xl ${isContact ? 'right-0' : 'left-0'}`}>
                      {QUICK_EMOJIS.map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          onClick={(e) => { e.stopPropagation(); addReaction(message.id, emoji) }}
                          className="rounded-full px-1 text-lg transition hover:scale-125 hover:bg-white/10"
                        >{emoji}</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          {videoProcessingStage ? (
            <div className="message-row outgoing inline-processing-row flex">
              <div className="inline-processing">
                <div className="inline-processing-spinner" />
                <div className="inline-processing-stage">
                  <span className="inline-processing-emoji">{videoProcessingStage.emoji}</span>
                  <span className="inline-processing-text">{videoProcessingStage.text}</span>
                </div>
              </div>
            </div>
          ) : null}

          {/* Avatar away status (fun delay before reading) */}
          {avatarAwayStatus && !avatarStatus ? (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-[20px] rounded-tl-[6px] border border-white/[0.06] bg-[#1a2332] px-4 py-2.5 shadow-[0_2px_8px_rgba(0,0,0,0.12)]">
                <span className="text-[13px]">{'\u{1F634}'}</span>
                <span className="text-[13px] italic text-white/45">
                  <span className="font-medium text-white/60">{getAvatarFirstName(owner.display_name)}</span>
                  {' '}
                  {t(locale, avatarAwayStatus as any)}
                </span>
              </div>
            </div>
          ) : null}

          {/* Avatar active status (typing, thinking, etc.) */}
          {avatarStatus ? (
            <div className="flex justify-start">
              <div className="flex items-center gap-2.5 rounded-[20px] rounded-tl-[6px] border border-white/[0.06] bg-[#1a2332] px-4 py-3 shadow-[0_2px_8px_rgba(0,0,0,0.12)]">
                <div className="flex gap-1">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#00d4a1]" style={{ animationDelay: '0ms' }} />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#00d4a1]" style={{ animationDelay: '150ms' }} />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#00d4a1]" style={{ animationDelay: '300ms' }} />
                </div>
                <span className="text-[13px] text-white/50">
                  <span className="font-medium text-white/70">{getAvatarFirstName(owner.display_name)}</span>
                  {' '}
                  {avatarStatus === 'listening' ? t(locale, 'isListening')
                    : avatarStatus === 'watching' ? t(locale, 'isWatching')
                    : avatarStatus === 'looking' ? t(locale, 'isLooking')
                    : avatarStatus === 'thinking' ? t(locale, 'isThinking')
                    : avatarStatus === 'writing' ? t(locale, 'isWriting')
                    : avatarStatus === 'designing' ? t(locale, 'isDesigning')
                    : avatarStatus === 'recording' ? t(locale, 'isRecording')
                    : t(locale, 'isWriting')}
                </span>
              </div>
            </div>
          ) : null}

          <div ref={messagesEndRef} />
        </div>
      </main>

      {profileCardOpen ? (
        <div className="absolute inset-0 z-50 flex items-end sm:items-center sm:justify-center">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setProfileCardOpen(false)} />
          <div className="relative z-10 max-h-[85dvh] w-full overflow-y-auto rounded-t-[32px] border border-white/8 bg-[linear-gradient(180deg,#0b1a28_0%,#081420_46%,#07111b_100%)] p-5 shadow-[0_-20px_80px_rgba(0,0,0,0.45)] sm:max-h-[90dvh] sm:w-[min(520px,92vw)] sm:rounded-[28px] sm:p-6">
            <div className="mb-5 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setProfileCardOpen(false)}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-white/12 bg-white/[0.03] text-white/80 transition hover:text-white"
                aria-label="Close profile card"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.25" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <p className="text-xs uppercase tracking-[0.22em] text-white/42">Contact info</p>
              <div className="h-10 w-10" />
            </div>

            <div className="flex flex-col items-center text-center">
              <img
                src={resolveAvatarUrl(owner.display_name)}
                alt={owner.display_name}
                className="h-28 w-28 rounded-full object-cover ring-2 ring-white/12"
              />
              <h2 className="mt-4 text-2xl font-semibold tracking-[-0.02em] text-white">{owner.display_name}</h2>
              <p className="mt-2 max-w-md text-sm leading-6 text-white/72">
                {profileSummary || 'No profile bio added yet.'}
              </p>
            </div>

            <div className="mt-6 space-y-4">
              <section className="rounded-[22px] border border-white/8 bg-white/[0.03] p-4">
                <p className="text-[11px] uppercase tracking-[0.22em] text-white/42">Expertise</p>
                <p className="mt-2 text-sm leading-6 text-white/82">{owner.expertise?.trim() || 'No expertise details added yet.'}</p>
              </section>

              <section className="rounded-[22px] border border-white/8 bg-white/[0.03] p-4">
                <p className="text-[11px] uppercase tracking-[0.22em] text-white/42">Main Topics</p>
                {mainTopics.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {mainTopics.map((topic) => (
                      <span key={topic} className="rounded-full border border-[#75f0df]/28 bg-[#0c8a6d]/20 px-3 py-1 text-xs text-[#9af8ea]">
                        {topic}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-white/62">No topics added yet.</p>
                )}
              </section>

              <section className="rounded-[22px] border border-white/8 bg-white/[0.03] p-4">
                <p className="text-[11px] uppercase tracking-[0.22em] text-white/42">Strengths</p>
                {strengths.length > 0 ? (
                  <ul className="mt-3 space-y-2">
                    {strengths.map((strength) => (
                      <li key={strength} className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2 text-sm text-white/82">
                        {strength}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-white/62">No strengths added yet.</p>
                )}
              </section>
            </div>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="relative z-10 border-t border-white/8 bg-[#101b28]/88 px-4 py-2 text-center text-sm text-red-300 backdrop-blur-xl">
          <span>{error}</span>
          {failedMessage ? (
            <button
              type="button"
              onClick={() => handleSendText(failedMessage)}
              className="ml-2 rounded-full bg-white/10 px-3 py-0.5 text-xs font-medium text-white hover:bg-white/20 transition-colors"
            >
              Tap to retry
            </button>
          ) : null}
        </div>
      ) : null}

      {recordingMode !== 'idle' && captureKind === 'voice' ? (
        <div className="relative z-20 border-t border-white/8 bg-[#101b28]/88 px-4 py-3 backdrop-blur-2xl">
          <div className="mx-auto flex max-w-2xl items-center gap-3 rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(17,29,44,0.9),rgba(10,20,33,0.95))] px-4 py-3 text-white shadow-[0_20px_60px_rgba(0,0,0,0.28)]">
            <button
              type="button"
              onClick={() => finishVoiceRecording('cancel')}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#ff7a7a] to-[#e23e63] text-white shadow-[0_0_24px_rgba(255,91,118,0.36)]"
            >
              <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              {WAVEFORM_BARS.map((bar) => (
                <span
                  key={`record-${bar}`}
                  className="w-1 animate-pulse rounded-full bg-[#7be3ce]"
                  style={{
                    height: `${[6, 12, 18, 10, 22, 14, 8, 20, 12, 16, 24, 10, 18, 8, 14][bar]}px`,
                    animationDelay: `${bar * 70}ms`,
                  }}
                />
              ))}
            </div>
            <span className="text-sm font-medium text-white/80">{formatClock(recordingSeconds)}</span>
          </div>
        </div>
      ) : null}

      <footer className={`relative z-20 border-t border-white/[0.06] px-3 pt-2.5 backdrop-blur-2xl ${isDesktopLayout ? 'bg-[rgba(8,18,28,0.55)]' : 'bg-[#0a1420]/80'}`}>
        <div className={`mx-auto flex items-end gap-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] ${isDesktopLayout ? 'max-w-[720px]' : 'max-w-2xl'}`}>
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setMediaMenuOpen((current) => !current)}
              disabled={sending || recordingMode !== 'idle' || videoRecordingMode !== 'idle'}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/[0.08] bg-[#1a2332] text-white/60 transition hover:border-white/15 hover:text-white disabled:opacity-40"
              title="Media options"
            >
              <svg className={`h-5 w-5 transition ${mediaMenuOpen ? 'rotate-45' : ''}`} fill="currentColor" viewBox="0 0 24 24">
                <path d="M19 11H13V5h-2v6H5v2h6v6h2v-6h6z" />
              </svg>
            </button>

            {mediaMenuOpen ? (
              <div className="absolute bottom-14 left-0 w-48 rounded-3xl border border-white/10 bg-[linear-gradient(180deg,rgba(17,29,44,0.96),rgba(10,20,33,0.98))] p-2 shadow-[0_24px_80px_rgba(0,0,0,0.36)] backdrop-blur-2xl">
                <button
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm text-white/88 transition hover:bg-white/6"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#173447] text-[#88ffe4]">
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                      <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2 1.586-1.586a2 2 0 012.828 0L20 14" />
                      <path d="M14 8h.01" />
                      <rect x="3" y="4" width="18" height="16" rx="2" />
                    </svg>
                  </span>
                  <span>Share image</span>
                </button>
              </div>
            ) : null}
          </div>

          <div className="min-w-0 flex-1">
            <input
              type="text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void handleSendText()
                }
              }}
              placeholder="Type a message"
              disabled={sending || recordingMode !== 'idle' || videoRecordingMode !== 'idle'}
              className="w-full rounded-full border border-white/[0.08] bg-[#1a2332] px-4 py-3 text-base text-white placeholder-white/30 outline-none transition focus:border-[#00a884]/40 focus:ring-1 focus:ring-[#00a884]/20 disabled:opacity-40"
              style={{ fontSize: '16px' }}
            />
          </div>

          <button
            type="button"
            onClick={() => void openVideoOverlay()}
            disabled={sending || text.trim().length > 0 || mediaMenuOpen || recordingMode !== 'idle' || videoRecordingMode !== 'idle'}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#1f8fff] text-white shadow-[0_2px_12px_rgba(31,143,255,0.25)] transition hover:bg-[#2f98ff] disabled:opacity-40"
            title="Record video message"
          >
            <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M17 10.5V7a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1v-3.5l4 4v-11l-4 4z" />
            </svg>
          </button>

            <button
              type="button"
              onClick={() => void openVoiceOverlay()}
              disabled={sending || text.trim().length > 0 || mediaMenuOpen || videoRecordingMode !== 'idle'}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#00a884] text-white shadow-[0_2px_12px_rgba(0,168,132,0.25)] transition hover:bg-[#00bf96] disabled:opacity-40"
              title="Record voice note"
            >
            <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1 1.93c-3.94-.49-7-3.85-7-7.93h2c0 3.31 2.69 6 6 6s6-2.69 6-6h2c0 4.08-3.06 7.44-7 7.93V19h4v2H8v-2h4v-3.07z" />
            </svg>
          </button>

          <button
            type="button"
            onClick={() => void handleSendText()}
            disabled={!text.trim() || sending || recordingMode !== 'idle' || videoRecordingMode !== 'idle'}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#00a884] text-white shadow-[0_2px_12px_rgba(0,168,132,0.25)] transition hover:bg-[#00bf96] disabled:opacity-40"
            title="Send message"
          >
            <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>

        <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageSelected} />
      </footer>
      </div>

      {voiceOverlayOpen ? (
        <div className="absolute inset-0 z-30 flex items-end bg-[#02060dd9] p-4 sm:items-center sm:justify-center">
          <div className="w-full max-w-md rounded-[32px] border border-white/10 bg-[linear-gradient(180deg,rgba(17,29,44,0.96),rgba(10,20,33,0.98))] p-5 shadow-[0_28px_100px_rgba(0,0,0,0.45)] backdrop-blur-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">Voice message</h2>
              <button type="button" onClick={closeVoiceOverlay} className="text-sm text-white/60">Cancel</button>
            </div>
            <div className="mt-5 rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(26,42,61,0.92),rgba(18,31,47,0.96))] px-4 py-5">
              <div className="flex items-center gap-3">
                <div className={`h-3 w-3 rounded-full ${recordingMode !== 'idle' ? 'animate-pulse bg-[#ff6b7f]' : 'bg-[#11c2a0]'}`} />
                <span className="text-sm text-white/80">
                  {recordingMode !== 'idle' ? 'Recording...' : voiceDraftReady ? 'Ready to send' : 'Preparing...'}
                </span>
                <span className="ml-auto text-sm font-medium text-white/70">{formatClock(voiceDraftReady ? voiceDraftSeconds : recordingSeconds)}</span>
              </div>
              <div className="mt-4 flex items-end gap-1">
                {WAVEFORM_BARS.map((bar) => (
                  <span
                    key={`voice-overlay-${bar}`}
                    className={`block w-2 rounded-full ${voiceDraftReady ? 'bg-[#89fbe3]/60' : 'animate-pulse bg-[#ff6b7f]'}`}
                    style={{ height: `${[10, 20, 30, 16, 34, 24, 12, 28, 18, 26, 36, 16, 28, 14, 22][bar]}px`, animationDelay: `${bar * 70}ms` }}
                  />
                ))}
              </div>
              {voiceDraftTranscript ? (
                <div className="mt-4 rounded-2xl bg-black/15 px-3 py-2 text-sm text-white/84">
                  {voiceDraftTranscript}
                </div>
              ) : voiceDraftReady ? (
                <div className="mt-4 rounded-2xl bg-black/15 px-3 py-2 text-sm text-white/50 italic">
                  Transcription after send (multilingual)
                </div>
              ) : null}
              {voiceDraftUrl ? <audio className="mt-4 w-full" controls src={voiceDraftUrl} /> : null}
            </div>
            <div className="mt-5 flex items-center justify-between gap-3">
              {recordingMode !== 'idle' ? (
                <button
                  type="button"
                  onClick={() => void stopVoiceIntoDraft()}
                  className="flex-1 rounded-full bg-gradient-to-r from-[#ff6b7f] to-[#e63d62] px-4 py-3 text-sm font-semibold text-white"
                >
                  Stop recording
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={closeVoiceOverlay}
                    className="flex-1 rounded-full border border-white/10 px-4 py-3 text-sm font-semibold text-white/80"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void sendVoiceDraft()}
                    disabled={!voiceDraftReady || sending}
                    className="flex-1 rounded-full bg-gradient-to-r from-[#11c2a0] to-[#38a9ff] px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
                  >
                    Send
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <VideoRecorder
        open={videoOverlayOpen}
        recordingMode={videoRecordingMode}
        recordingSeconds={videoRecordingSeconds}
        progressRingOffset={progressRingOffset}
        timeWarning={timeWarning}
        videoHint={videoHint}
        videoStatusText={videoStatusText}
        validationText={validationText}
        validationType={validationType}
        canRecord={canRecord}
        previewMode={previewMode}
        previewDuration={videoPreviewDuration}
        previewCurrentTime={previewCurrentTime}
        previewProgress={previewProgress}
        previewPlaying={previewPlaying}
        videoPreviewRef={videoPreviewRef}
        onClose={closeVideoOverlay}
        onRecordClick={handleVideoRecordButton}
        onRotate={rotatePreview}
        onSend={sendVideoBlob}
        onTogglePreviewPlayback={togglePreviewPlayback}
        onSeekPreview={seekPreviewToRatio}
      />

      {captionDraft ? (
        <div className="absolute inset-0 z-30 flex items-end bg-[#02060dcc] p-4 sm:items-center sm:justify-center">
          <div className="w-full max-w-md rounded-[32px] border border-white/10 bg-[linear-gradient(180deg,rgba(17,29,44,0.96),rgba(10,20,33,0.98))] p-4 shadow-[0_28px_100px_rgba(0,0,0,0.45)] backdrop-blur-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">Send image</h2>
              <button type="button" onClick={closeCaptionDraft} className="text-sm text-white/60">
                Cancel
              </button>
            </div>
            <img src={captionDraft.previewUrl} alt="Preview" className="max-h-80 w-full rounded-2xl object-cover" />
            <input
              type="text"
              value={captionText}
              onChange={(event) => setCaptionText(event.target.value)}
              placeholder="Add a caption..."
              className="mt-4 w-full rounded-full border border-white/10 bg-[linear-gradient(180deg,rgba(26,42,61,0.92),rgba(18,31,47,0.96))] px-4 py-3 text-base text-white placeholder-white/35 outline-none focus:border-[#79f5df]/45 focus:ring-2 focus:ring-[#79f5df]/18"
              style={{ fontSize: '16px' }}
            />
            <button
              type="button"
              onClick={() => void sendImageDraft()}
              className="mt-4 w-full rounded-full bg-gradient-to-r from-[#11c2a0] to-[#38a9ff] px-4 py-3 text-sm font-semibold text-white shadow-[0_0_36px_rgba(42,196,231,0.22)] transition hover:brightness-110"
            >
              Send
            </button>
          </div>
        </div>
      ) : null}

      {/* Forward modal */}
      {forwardModalOpen && (
        <div className="absolute inset-0 z-40 flex items-end bg-[#02060dcc] p-4 sm:items-center sm:justify-center" onClick={() => { setForwardModalOpen(false); setForwardSending(null) }}>
          <div className="w-full max-w-md rounded-[32px] border border-white/10 bg-[linear-gradient(180deg,rgba(17,29,44,0.97),rgba(10,20,33,0.99))] p-5 shadow-[0_28px_100px_rgba(0,0,0,0.5)] backdrop-blur-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">{t(locale, 'forwardTo')}</h2>
              <button type="button" onClick={() => { setForwardModalOpen(false); setForwardSending(null) }} className="text-sm text-white/60 hover:text-white/80">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <p className="mt-1 text-sm text-white/50">{selectedIds.size} {t(locale, 'selectedCount')}</p>

            <div className="mt-5 max-h-[50vh] space-y-2 overflow-y-auto">
              {forwardLoading ? (
                <div className="flex justify-center py-8">
                  <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#1f2c34] border-t-[#00a884]" />
                </div>
              ) : forwardOwners.length === 0 ? (
                <p className="py-6 text-center text-sm text-white/40">No avatars available.</p>
              ) : (
                forwardOwners.map((fw) => (
                  <button
                    key={fw.id}
                    type="button"
                    onClick={() => void forwardToOwner(fw.id)}
                    disabled={forwardSending !== null}
                    className={`w-full rounded-[20px] border px-4 py-4 text-left transition ${
                      forwardSending === fw.id
                        ? 'border-[#00a884]/50 bg-[#00a884]/10'
                        : 'border-white/6 bg-white/[0.02] hover:border-[#00a884]/40 hover:bg-[#00a884]/[0.06]'
                    } disabled:opacity-60`}
                  >
                    <div className="flex items-center gap-3">
                      <img src={resolveAvatarUrl(fw.display_name)} alt={fw.display_name} className="h-11 w-11 rounded-full object-cover ring-2 ring-white/10" />
                      <p className="flex-1 truncate text-sm font-semibold text-white">{fw.display_name}</p>
                      {forwardSending === fw.id ? (
                        <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#1f2c34] border-t-[#00a884]" />
                      ) : (
                        <svg className="h-4 w-4 text-white/30" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 12h15" /></svg>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Toast notification */}
      {toastMessage && (
        <div className="pointer-events-none absolute inset-x-0 bottom-24 z-50 flex justify-center">
          <div className="rounded-full border border-[#00a884]/30 bg-[#0d1826]/95 px-5 py-2.5 text-sm font-medium text-[#00a884] shadow-[0_12px_40px_rgba(0,0,0,0.4)] backdrop-blur-xl">
            {toastMessage}
          </div>
        </div>
      )}
    </div>
  )
}
