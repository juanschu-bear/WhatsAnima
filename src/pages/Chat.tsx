import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getConversation, listMessages, listPerceptionLogs, sendMessage, createPerceptionLog, listAllOwners, findContactByEmail, findOrCreateConversation, createContactForOwner } from '../lib/api'
import { resolveAvatarUrl } from '../lib/avatars'
import { t } from '../lib/i18n'
import {
  uploadMediaToStorage,
  callOpmApi,
  readVideoMetadata, correctVideoOrientation,
} from '../lib/mediaUtils'
import { useReactions, QUICK_EMOJIS } from '../hooks/useReactions'
import { useReadReceipts } from '../hooks/useReadReceipts'
import { useSessionMemory } from '../hooks/useSessionMemory'
import { useMessageSelection } from '../hooks/useMessageSelection'
import { useVoiceRecording } from '../hooks/useVoiceRecording'
import { useVideoCapture } from '../hooks/useVideoCapture'
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
  }
  wa_contacts: { display_name: string }
}

interface CaptionDraft {
  file: File
  kind: 'image' | 'video'
  previewUrl: string
}
const WAVEFORM_BARS = Array.from({ length: 15 }, (_, index) => index)

function formatClock(totalSeconds: number) {
  const safeSeconds = Number.isFinite(totalSeconds) ? Math.max(0, totalSeconds) : 0
  const minutes = Math.floor(safeSeconds / 60)
  const seconds = Math.floor(safeSeconds % 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function formatMessageTime(dateStr: string) {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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

function isRecordedVideoMessage(message: Message) {
  return (message.content || '') === '[Recorded video]'
}

function isPlaceholderContent(message: Message) {
  return ['[Image]', '[Video]', '[Recorded video]', '[Voice message]', 'Voice note'].includes(
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
              Retry
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

const VideoPlayOverlay = ({ hidden, rounded }: { hidden?: boolean; rounded?: boolean }) => (
  <div
    className={`absolute inset-0 flex items-center justify-center transition-opacity ${rounded ? 'rounded-full' : 'rounded-xl'} ${hidden ? 'pointer-events-none opacity-0' : 'bg-black/25 opacity-100 hover:opacity-80'}`}
  >
    <svg className="h-9 w-9 drop-shadow-[0_1px_3px_rgba(0,0,0,0.3)]" viewBox="0 0 24 24" fill="white">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  </div>
)

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
  const [isVideoPlaying, setIsVideoPlaying] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

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

  const recorded = isRecordedVideoMessage(message)
  const isSelfie = recorded

  function handleVideoClick() {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      video.play().catch(() => undefined)
      setIsVideoPlaying(true)
    } else {
      video.pause()
      setIsVideoPlaying(false)
    }
  }

  if (recorded) {
    // Recorded videos: circular bubble with cyan glow (like ANIMA Connect)
    return (
      <div className="w-[180px] bg-transparent p-1">
        <div
          className="video-bubble-circle relative h-[172px] w-[172px] cursor-pointer overflow-hidden rounded-full border-[3px] border-[#00d4ff] shadow-[0_0_14px_rgba(0,212,255,0.3),0_0_28px_rgba(0,212,255,0.12)] transition-shadow duration-600"
          onClick={handleVideoClick}
        >
          <video
            ref={videoRef}
            src={message.media_url ?? undefined}
            playsInline
            muted
            loop
            preload="metadata"
            className={`h-full w-full object-cover rounded-full ${isSelfie ? '-scale-x-100' : ''}`}
            onPlay={() => setIsVideoPlaying(true)}
            onPause={() => setIsVideoPlaying(false)}
            onEnded={() => setIsVideoPlaying(false)}
          />
          <VideoPlayOverlay hidden={isVideoPlaying} rounded />
        </div>
        <div className={`text-center text-[12px] pt-1.5 pb-0.5 ${isContact ? 'text-white/40' : 'text-white/30'}`}>
          {message.duration_sec ? formatClock(message.duration_sec) : ''}
        </div>
      </div>
    )
  }

  // Gallery videos: rectangular player with custom play overlay
  return (
    <div className="w-[260px] max-w-[75vw] bg-transparent p-1">
      <div
        className="relative cursor-pointer overflow-hidden rounded-xl bg-[#1c1c1e]"
        onClick={handleVideoClick}
      >
        <video
          ref={videoRef}
          src={message.media_url ?? undefined}
          playsInline
          muted
          loop
          preload="metadata"
          className="block w-full max-h-[300px] object-contain rounded-xl"
          onPlay={() => setIsVideoPlaying(true)}
          onPause={() => setIsVideoPlaying(false)}
          onEnded={() => setIsVideoPlaying(false)}
        />
        <VideoPlayOverlay hidden={isVideoPlaying} />
      </div>
      <div className="px-2 pb-1 pt-2">
        {!isPlaceholderContent(message) ? <div className="text-[14px] text-white/90">{message.content}</div> : null}
        <div className={`mt-1 flex items-center justify-between gap-4 text-[10px] ${isContact ? 'text-white/40' : 'text-white/30'}`}>
          <span>{message.duration_sec ? formatClock(message.duration_sec) : ''}</span>
          <span>{formatMessageTime(message.created_at)}</span>
        </div>
      </div>
    </div>
  )
})

export default function Chat() {
  const navigate = useNavigate()
  const { conversationId } = useParams<{ conversationId: string }>()
  const [conversation, setConversation] = useState<ConversationData | null>(null)
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false)
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
  const [inlineProcessing, setInlineProcessing] = useState<{ emoji: string; text: string } | null>(null)
  const avatarReplyInFlight = useRef(new Set<string>())
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
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
  const sendAvatarReplyRef = useRef<(text: string, options?: { useVoice?: boolean; isVoice?: boolean; perception?: any }) => Promise<boolean>>(async () => false)

  const {
    recordingMode, setRecordingMode, captureKind, setCaptureKind,
    recordingSeconds, setRecordingSeconds, recordTimerRef,
    speechRecognitionRef, browserTranscriptRef, audioStartRef, audioStreamRef,
    stopRecordingTimer, startSpeechRecognition,
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
    videoOverlayOpen, videoOverlayMode, videoPermissionPending,
    videoValidationText, videoValidationTone, videoCanRecord,
    videoPreviewUrl, videoDraftSeconds,
    videoTimeWarning, progressRingOffset, manualRotation,
    PROGRESS_RING_CIRCUMFERENCE,
    videoPreviewRef, videoStreamRef, faceValidationIntervalRef,
    openVideoOverlay, closeVideoOverlay,
    startLiveVideoRecording, stopLiveVideoRecording, sendRecordedVideoDraft,
    rotatePreview,
  } = useVideoCapture({
    conversationId,
    conversation,
    avatarDisplayName: conversation?.wa_owners?.display_name,
    shared: {
      setRecordingMode, setCaptureKind, setRecordingSeconds,
      recordTimerRef, speechRecognitionRef, browserTranscriptRef, audioStartRef,
      stopRecordingTimer, startSpeechRecognition,
    },
    onSending: setSending,
    onError: setError,
    onMessageSent: (msg) => setMessages((current) => [...current, msg as Message]),
    onTranscript: (id, text) => setTranscriptMap((current) => ({ ...current, [id]: text })),
    onProcessingStage: (emoji, text) => setInlineProcessing(emoji || text ? { emoji, text } : null),
    sendAvatarReply: (...args) => sendAvatarReplyRef.current(...args),
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

      for (const msg of selected) {
        const prefix = `[${t(locale, 'forwardedMessage')} — ${ownerName}]\n`
        const content = msg.type === 'voice'
          ? `${prefix}[Voice] ${msg.content || ''}`
          : msg.type === 'image'
          ? `${prefix}[Image] ${msg.content || ''}`
          : msg.type === 'video'
          ? `${prefix}[Video] ${msg.content || ''}`
          : `${prefix}${msg.content || ''}`

        await sendMessage(convId, 'contact', 'text', content.trim())
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
      if (faceValidationIntervalRef.current) window.clearInterval(faceValidationIntervalRef.current)
      audioStreamRef.current?.getTracks().forEach((track) => track.stop())
      videoStreamRef.current?.getTracks().forEach((track) => track.stop())
      speechRecognitionRef.current?.stop?.()
      if (voiceDraftUrl) URL.revokeObjectURL(voiceDraftUrl)
      if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl)
    }
  }, [videoPreviewUrl, voiceDraftUrl])

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

    // Capture values from component state at call time so they survive unmount
    const capturedConversationId = conversationId
    const capturedConversation = conversation
    const capturedMessages = messages

    let replySucceeded = false
    // Set initial status based on context
    if (options?.isVoice) setAvatarStatus('listening')
    else if (options?.isVideo) setAvatarStatus('watching')
    else if (options?.isImage) setAvatarStatus('looking')
    else setAvatarStatus('thinking')

    try {
      // --- Realistic voice-message delay (client-side UX only) ---
      if (options?.isVoice && options.voiceDurationSec) {
        await new Promise((r) => setTimeout(r, VOICE_SEEN_DELAY_MS))
        setAvatarStatus('listening')
        const listeningMs = getVoiceListeningDelay(options.voiceDurationSec)
        await new Promise((r) => setTimeout(r, listeningMs))
      }

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

      // Build history from current messages
      const history = capturedMessages
        .slice(-10)
        .map((message) => ({
          role: message.sender === 'contact' ? 'user' : 'assistant',
          content: (message.content || '').trim(),
          msgType: message.type as string,
        }))
        .filter((message) => message.content.length > 0)

      const useVoice = options?.useVoice ?? true

      // --- Fire ONE request to server-side avatar-reply endpoint ---
      // The server handles: chat → TTS → upload → save to DB.
      // Even if this component unmounts, the server finishes and the reply
      // is in the DB when the user comes back.
      setAvatarStatus('writing')
      const response = await fetch('/api/avatar-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: seedText,
          conversationId: capturedConversationId,
          history,
          image_url: options?.imageUrl,
          isImage: options?.isImage,
          isVideo: options?.isVideo,
          isVoice: options?.isVoice,
          perception: options?.perception,
          userMessageId: options?.userMessageId,
          useVoice,
          voiceId: capturedConversation?.wa_owners?.voice_id,
        }),
      })

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        console.error('[sendAvatarReply] Server error:', data?.error || response.status)
        throw new Error(data?.error || `Server returned ${response.status}`)
      }

      // Server returns { messages: [...savedMessages] }
      const savedMessages: Message[] = data.messages || []
      if (savedMessages.length === 0) throw new Error('No messages returned')

      // Add all saved messages to local state
      for (const msg of savedMessages) {
        setMessages((current) => [...current, msg])
        markAsInstantlyRead(String(msg.id))

        // If voice reply, add transcript mapping
        if (msg.type === 'voice' && msg.content && msg.media_url) {
          setTranscriptMap((current) => ({
            ...current,
            [String(msg.id)]: String(msg.content),
          }))
        }
      }

      replySucceeded = true

      // ── Notification ──
      playNotificationSound()
      if (!isAppVisible()) {
        const avatarName = capturedConversation?.wa_owners?.display_name || 'Avatar'
        const lastMsg = savedMessages[savedMessages.length - 1]
        const preview = lastMsg.type === 'image'
          ? 'Sent an image'
          : typeof lastMsg.content === 'string'
            ? lastMsg.content.slice(0, 100)
            : 'New message'
        showLocalNotification(avatarName, preview, capturedConversationId)
        incrementUnreadBadge()
      }
    } catch (err) {
      console.error('Avatar reply failed:', err)
      // The server-side pipeline may still be running and will save the reply to DB.
      // Only send fallback if we're certain the server didn't process it (e.g. network error).
      // Check if a reply was already saved server-side before sending fallback.
      if (capturedConversationId && options?.userMessageId) {
        try {
          // Give the server a moment to finish if it's still processing
          await new Promise((r) => setTimeout(r, 2000))
          const checkResponse = await fetch('/api/avatar-reply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: seedText,
              conversationId: capturedConversationId,
              userMessageId: options.userMessageId,
              history: [],
              useVoice: false,
            }),
          })
          const checkData = await checkResponse.json().catch(() => ({}))
          if (checkData?._deduplicated && checkData?.messages?.length > 0) {
            // Server already saved the reply — add it to local state
            for (const msg of checkData.messages as Message[]) {
              setMessages((current) => [...current, msg])
            }
            replySucceeded = true
          }
        } catch {
          // Dedup check also failed — send fallback
        }
      }

      if (!replySucceeded && capturedConversationId) {
        try {
          const name = getAvatarFirstName(capturedConversation?.wa_owners?.display_name)
          const excuses = [
            `${name} is in a meeting right now. Back in a sec!`,
            `${name} just stepped out for a coffee. One moment!`,
            `${name} is on the phone. Back in a sec!`,
            `${name} is taking a quick break. Hang tight!`,
            `${name} got distracted for a second. Back shortly!`,
            `${name} is dealing with something real quick. Back in a moment!`,
          ]
          const excuse = excuses[Math.floor(Math.random() * excuses.length)]
          const fallback = await sendMessage(capturedConversationId, 'avatar', 'text', excuse)
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

  function getImmersiveError(errorType: string, name: string): string {
    const errors: Record<string, string> = {
      processing_timeout: `${name} is in a meeting right now. Will watch your video as soon as possible.`,
      api_down: `${name} is currently unavailable. Try again in a moment.`,
      no_face_detected: `${name} couldn't see your face clearly. Try recording again with better lighting.`,
      processing_error: `${name} had trouble reading your message. Want to send it again?`,
      no_transcript: `${name} watched your video but the audio was unclear. Responding based on what was visible.`,
      video_too_long: `That was a bit long! Keep it under 5 minutes so ${name} can focus.`,
    }
    return errors[errorType] || `${name} had trouble reading your message. Want to send it again?`
  }

  function handleOpenVideoOverlay() {
    setMediaMenuOpen(false)
    void openVideoOverlay()
  }

  function openCaptionDraft(file: File, kind: 'image' | 'video') {
    const previewUrl = URL.createObjectURL(file)
    setMediaMenuOpen(false)
    setCaptionText('')
    setCaptionDraft((current) => {
      if (current) URL.revokeObjectURL(current.previewUrl)
      return { file, kind, previewUrl }
    })
  }

  function closeCaptionDraft() {
    setCaptionDraft((current) => {
      if (current) URL.revokeObjectURL(current.previewUrl)
      return null
    })
    setCaptionText('')
  }

  async function sendImageOrVideoDraft() {
    if (!captionDraft || !conversationId) return

    const { file, kind } = captionDraft
    const caption = captionText.trim()
    closeCaptionDraft()
    setSending(true)
    setError(null)

    try {
      if (kind === 'image') {
        setAvatarStatus('looking')
        const mediaUrl = await uploadMediaToStorage(conversation!, file, 'image')
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
        return
      }

      setAvatarStatus('watching')
      const rotatedFile = await correctVideoOrientation(file)
      const metadata = await readVideoMetadata(rotatedFile)
      const avatarName = getAvatarFirstName(conversation?.wa_owners?.display_name)
      const [mediaUrl, opmResponse] = await Promise.all([
        uploadMediaToStorage(conversation!, rotatedFile, 'video'),
        callOpmApi(conversation!, rotatedFile, 'video', {
          avatarFirstName: avatarName,
          onStage: (emoji, text, _progress) => setInlineProcessing(emoji || text ? { emoji, text } : null),
        }).catch((error) => {
          console.error('[Video] OPM uploaded video analysis failed:', error)
          return null
        }),
      ])
      if (!mediaUrl) throw new Error('upload failed')
      const message = await sendMessage(
        conversationId,
        'contact',
        'video',
        caption || '[Video]',
        mediaUrl,
        metadata.duration || null || undefined
      )
      setMessages((current) => [...current, message as Message])
      simulateAvatarRead((message as Message).id)

      createPerceptionLog({
        messageId: (message as Message).id,
        conversationId: conversationId!,
        contactId: conversation!.contact_id,
        ownerId: conversation!.owner_id,
        transcript: opmResponse?.transcript?.trim() || null,
        audioDurationSec: metadata.duration || null,
        primaryEmotion: opmResponse?.perception?.primary_emotion ?? null,
        secondaryEmotion: opmResponse?.perception?.secondary_emotion ?? null,
        firedRules: opmResponse?.fired_rules ?? null,
        behavioralSummary: opmResponse?.behavioral_summary ?? opmResponse?.perception?.behavioral_summary ?? opmResponse?.interpretation?.behavioral_summary ?? null,
        conversationHooks: opmResponse?.conversation_hooks ?? opmResponse?.interpretation?.conversation_hooks ?? null,
        prosodicSummary: opmResponse?.prosodic_summary ?? null,
        mediaType: 'video',
      }).catch((logErr) => console.warn('[perception-log]', logErr.message))

      const transcript = opmResponse?.transcript?.trim() || ''
      const videoMessageText = caption
        ? (transcript ? `${caption}\n\n[Transcribed from video]: ${transcript}` : caption)
        : transcript || 'an uploaded video'
      const vidReplied = await sendAvatarReply(videoMessageText, {
        useVoice: false,
        isVideo: true,
        videoDurationSec: metadata.duration || undefined,
        perception: opmResponse,
        userMessageId: String((message as Message).id),
      })
      setInlineProcessing(null)
      if (vidReplied) maybeAvatarReact((message as Message).id)
    } catch (draftError: any) {
      console.error(draftError)
      setInlineProcessing(null)
      const name = getAvatarFirstName(conversation?.wa_owners?.display_name)
      setError(getImmersiveError(draftError?.message || 'processing_error', name))
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
    openCaptionDraft(file, 'image')
  }

  function handleVideoSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('video/')) {
      setError('Please choose a video file.')
      return
    }
    if (file.size > 500 * 1024 * 1024) {
      setError('Video must be under 500MB.')
      return
    }
    openCaptionDraft(file, 'video')
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
            <div className="relative">
              <img src={resolveAvatarUrl(owner.display_name)} alt={owner.display_name} className="h-10 w-10 rounded-full object-cover ring-1 ring-white/10" />
              <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[#0a1420] bg-[#00d4a1]" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-white">{owner.display_name}</h1>
              <p className="text-xs text-[#00d4a1]/80">{avatarStatus ? 'online' : 'online'}</p>
            </div>
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
                  ) : message.type === 'image' || message.type === 'video' ? (
                    <MediaMessageBubble isContact={isContact} message={message} isRead={isRead} />
                  ) : (
                    <div
                      className={`relative rounded-[20px] border px-4 py-3 text-[14.5px] leading-relaxed shadow-[0_2px_8px_rgba(0,0,0,0.12)] ${
                        isContact
                          ? 'rounded-tr-[6px] border-[#00a884]/15 bg-[#005c4b] text-white'
                          : 'rounded-tl-[6px] border-white/[0.06] bg-[#1a2332] text-white/[0.92]'
                      }`}
                    >
                      <span>{message.content}</span>
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

          {/* Inline OPM processing stages */}
          {inlineProcessing ? (
            <div className="flex justify-end">
              <div className="flex items-center gap-2.5 rounded-[20px] rounded-tr-[6px] border border-white/[0.06] bg-[#1a2332] px-4 py-2.5 shadow-[0_2px_8px_rgba(0,0,0,0.12)]">
                <div className="inline-processing-spinner" />
                <div className="inline-processing-stage">
                  <span className="text-[14px] leading-none">{inlineProcessing.emoji}</span>
                  <span className="text-[13px] text-white/50">{inlineProcessing.text}</span>
                </div>
              </div>
            </div>
          ) : null}

          <div ref={messagesEndRef} />
        </div>
      </main>

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
              disabled={sending || recordingMode !== 'idle'}
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
                <button
                  type="button"
                  onClick={() => videoInputRef.current?.click()}
                  className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm text-white/88 transition hover:bg-white/6"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#173447] text-[#88ffe4]">
                    <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M17 10.5V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-3.5l4 4v-11l-4 4z" />
                    </svg>
                  </span>
                  <span>Share video</span>
                </button>
                <button
                  type="button"
                  onClick={handleOpenVideoOverlay}
                  className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm text-white/88 transition hover:bg-white/6"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#173447] text-[#88ffe4]">
                    <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M17 10.5V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-3.5l4 4v-11l-4 4z" />
                    </svg>
                  </span>
                  <span>Record video</span>
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
              disabled={sending || recordingMode !== 'idle'}
              className="w-full rounded-full border border-white/[0.08] bg-[#1a2332] px-4 py-3 text-base text-white placeholder-white/30 outline-none transition focus:border-[#00a884]/40 focus:ring-1 focus:ring-[#00a884]/20 disabled:opacity-40"
              style={{ fontSize: '16px' }}
            />
          </div>

          <button
            type="button"
            onClick={() => void openVoiceOverlay()}
            disabled={sending || text.trim().length > 0 || videoOverlayOpen || mediaMenuOpen}
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
            disabled={!text.trim() || sending || recordingMode !== 'idle'}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#00a884] text-white shadow-[0_2px_12px_rgba(0,168,132,0.25)] transition hover:bg-[#00bf96] disabled:opacity-40"
            title="Send message"
          >
            <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>

        <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageSelected} />
        <input
          ref={videoInputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={handleVideoSelected}
        />
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

      {videoOverlayOpen ? (
        <div className="absolute inset-0 z-30 bg-black">
          <div className="flex h-full w-full flex-col items-center justify-between px-4 pb-[calc(env(safe-area-inset-bottom)+32px)] pt-[calc(env(safe-area-inset-top)+16px)]">
            {/* Header: Cancel + Timer */}
            <div className="flex w-full max-w-5xl items-center justify-between">
              <button
                type="button"
                onClick={() => { if (videoOverlayMode === 'preview') closeVideoOverlay(); else closeVideoOverlay(); }}
                className={`text-[17px] font-medium ${videoOverlayMode === 'preview' ? 'text-[#ff6b6b]' : 'text-white'} px-2 py-2`}
              >
                Cancel
              </button>
              <div className={`text-[20px] font-semibold tabular-nums ${videoTimeWarning ? 'text-[#ff3b30]' : captureKind === 'video' && recordingMode === 'recording' ? 'text-[#00d4ff]' : 'text-white'}`}>
                {formatClock(videoOverlayMode === 'preview' ? videoDraftSeconds : recordingSeconds)}
              </div>
              {captureKind === 'video' && recordingMode === 'recording' ? (
                <span className="text-[13px] text-white/60">Recording...</span>
              ) : <span />}
            </div>

            {/* Video circle with SVG progress ring */}
            <div className="flex flex-1 flex-col items-center justify-center">
              <div className="relative flex-shrink-0" style={{ width: isDesktopLayout ? 260 : 248, height: isDesktopLayout ? 260 : 248 }}>
                {/* SVG Progress Ring */}
                <svg
                  className="pointer-events-none absolute z-10"
                  style={{ inset: -6, width: 'calc(100% + 12px)', height: 'calc(100% + 12px)' }}
                  viewBox="0 0 260 260"
                >
                  <circle cx="130" cy="130" r="124" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="6" />
                  <circle
                    cx="130" cy="130" r="124"
                    fill="none"
                    stroke={videoTimeWarning ? '#ff3b30' : '#00d4ff'}
                    strokeWidth="6"
                    strokeLinecap="round"
                    strokeDasharray={PROGRESS_RING_CIRCUMFERENCE}
                    strokeDashoffset={progressRingOffset}
                    transform="rotate(-90 130 130)"
                    className="transition-[stroke-dashoffset] duration-100 linear"
                    style={{ filter: `drop-shadow(0 0 6px ${videoTimeWarning ? 'rgba(255,59,48,0.5)' : 'rgba(0,212,255,0.5)'})` }}
                  />
                </svg>

                {/* Video circle */}
                <div
                  className={`overflow-hidden rounded-full border-[3px] bg-[#1c1c1e] ${
                    videoTimeWarning
                      ? 'border-[#ff3b30] shadow-[0_0_18px_rgba(255,59,48,0.4),inset_0_0_12px_rgba(255,59,48,0.1)]'
                      : 'border-[#00d4ff] shadow-[0_0_18px_rgba(0,212,255,0.35),inset_0_0_12px_rgba(0,212,255,0.1)]'
                  } transition-[border-color,box-shadow] duration-400`}
                  style={{ width: isDesktopLayout ? 248 : 248, height: isDesktopLayout ? 248 : 248 }}
                >
                  {videoOverlayMode === 'preview' && videoPreviewUrl ? (
                    <video
                      src={videoPreviewUrl}
                      autoPlay
                      loop
                      playsInline
                      className="h-full w-full object-cover"
                      style={{ transform: manualRotation ? `rotate(${manualRotation}deg)` : undefined }}
                      ref={(el) => {
                        if (!el) return
                        // Try unmuted first, fallback to muted
                        el.muted = false
                        el.play().catch(() => {
                          el.muted = true
                          el.play().catch(() => undefined)
                        })
                      }}
                    />
                  ) : (
                    <video ref={videoPreviewRef} autoPlay muted playsInline className="-scale-x-100 h-full w-full object-cover" />
                  )}
                </div>
              </div>

              {/* Validation message */}
              <div className={`mt-6 inline-block rounded-[20px] px-5 py-2 text-[17px] font-semibold leading-snug transition-[opacity,color] duration-300 ${
                videoValidationTone === 'error' ? 'bg-[rgba(80,0,0,0.55)] text-[#ff6b6b]'
                : videoValidationTone === 'warning' ? 'bg-[rgba(80,60,0,0.6)] text-[#ffcc00]'
                : videoValidationTone === 'success' ? 'bg-[rgba(0,40,60,0.55)] text-[#00d4ff]'
                : 'bg-[rgba(0,0,0,0.55)] text-white/90'
              }`}>
                {videoValidationText}
              </div>

              {videoPermissionPending ? (
                <div className="absolute inset-0 flex items-center justify-center bg-black/28 backdrop-blur-sm">
                  <span className="rounded-full bg-black/40 px-4 py-2 text-sm text-white/85">Waiting for camera permission…</span>
                </div>
              ) : null}
            </div>

            {/* Controls */}
            <div className="flex w-full max-w-5xl flex-col items-center gap-3">
              {videoOverlayMode === 'preview' ? (
                <div className="flex items-center gap-4">
                  {/* Rotate button */}
                  <button
                    type="button"
                    onClick={rotatePreview}
                    className="flex h-12 w-12 items-center justify-center rounded-full bg-white/15 text-white transition active:scale-90 active:bg-white/25"
                    title="Rotate 90°"
                  >
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                  </button>
                  {/* Send button */}
                  <button
                    type="button"
                    onClick={() => void sendRecordedVideoDraft()}
                    disabled={sending}
                    className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-[#34c759] text-white shadow-[0_0_18px_rgba(52,199,89,0.3)] transition active:scale-92 disabled:opacity-40"
                  >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                  </button>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void (recordingMode !== 'idle' ? stopLiveVideoRecording() : startLiveVideoRecording())}
                    disabled={videoPermissionPending || (!videoCanRecord && recordingMode === 'idle')}
                    className={`flex h-[72px] w-[72px] items-center justify-center rounded-full border-4 ${
                      recordingMode !== 'idle'
                        ? 'border-[#ff6b7f] bg-[#ff6b7f]/24'
                        : 'border-white/85 bg-transparent'
                    } shadow-[0_0_40px_rgba(255,255,255,0.12)] disabled:opacity-40`}
                  >
                    {recordingMode !== 'idle' ? (
                      <div className="h-7 w-7 rounded-md bg-[#ff3b30]" />
                    ) : (
                      <div className="h-14 w-14 rounded-full bg-[#ff3b30]" />
                    )}
                  </button>
                  <span className="text-[13px] text-white/50">
                    {recordingMode !== 'idle' ? 'Tap to stop' : 'Tap to record'}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {captionDraft ? (
        <div className="absolute inset-0 z-30 flex items-end bg-[#02060dcc] p-4 sm:items-center sm:justify-center">
          <div className="w-full max-w-md rounded-[32px] border border-white/10 bg-[linear-gradient(180deg,rgba(17,29,44,0.96),rgba(10,20,33,0.98))] p-4 shadow-[0_28px_100px_rgba(0,0,0,0.45)] backdrop-blur-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">
                {captionDraft.kind === 'image' ? 'Send image' : 'Send video'}
              </h2>
              <button type="button" onClick={closeCaptionDraft} className="text-sm text-white/60">
                Cancel
              </button>
            </div>
            {captionDraft.kind === 'image' ? (
              <img src={captionDraft.previewUrl} alt="Preview" className="max-h-80 w-full rounded-2xl object-cover" />
            ) : (
              <video
                src={captionDraft.previewUrl}
                controls
                playsInline
                className="max-h-80 w-full rounded-2xl object-cover"
              />
            )}
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
              onClick={() => void sendImageOrVideoDraft()}
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
