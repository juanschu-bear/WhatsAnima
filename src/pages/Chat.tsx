import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import { useParams } from 'react-router-dom'
import { getConversation, listMessages, listPerceptionLogs, sendMessage, listAllOwners, findContactByEmail, findOrCreateConversation, createContactForOwner } from '../lib/api'
import { resolveAvatarUrl } from '../lib/avatars'
import { t } from '../lib/i18n'
import {
  blobToBase64,
  uploadAudioToStorage, uploadMediaToStorage,
  callOpmApi,
  readVideoMetadata, correctVideoOrientation,
} from '../lib/mediaUtils'
import { useReactions, QUICK_EMOJIS } from '../hooks/useReactions'
import { useReadReceipts } from '../hooks/useReadReceipts'
import { useSessionMemory } from '../hooks/useSessionMemory'
import { useMessageSelection } from '../hooks/useMessageSelection'
import { useVoiceRecording } from '../hooks/useVoiceRecording'
import { useVideoCapture } from '../hooks/useVideoCapture'

type MessageType = 'text' | 'voice' | 'video' | 'image'

interface Message {
  id: string
  sender: 'contact' | 'avatar'
  type: MessageType
  content: string | null
  media_url: string | null
  duration_sec: number | null
  created_at: string
  read_at?: string | null
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


const BOARDROOM_API_BASE = 'https://boardroom-api.onioko.com'
const LIVE_CALL_REPLICA_ID = 'rf5414018e80'
const LIVE_CALL_PERSONA_ID = 'pipecat-stream'

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
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDisplaySeconds(audio.currentTime)
        setProgress(audio.currentTime / audio.duration)
      }
    }
    audio.onended = () => {
      setIsPlaying(false)
      setDisplaySeconds(audio.duration || message.duration_sec || 0)
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
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = fraction * audio.duration
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
      <span className={`mt-1 flex items-center justify-end gap-0.5 text-[10px] ${isContact ? 'text-white/40' : 'text-white/30'}`}>
        {formatMessageTime(message.created_at)}
        {isContact && (
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
      </span>
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

  const recorded = isRecordedVideoMessage(message)
  return (
    <div
      className={`relative overflow-hidden border shadow-[0_2px_8px_rgba(0,0,0,0.12)] ${
        recorded ? 'rounded-full' : 'rounded-[20px]'
      } ${isContact
        ? `${recorded ? '' : 'rounded-tr-[6px]'} border-[#00a884]/15 bg-[#005c4b]`
        : `${recorded ? '' : 'rounded-tl-[6px]'} border-white/[0.06] bg-[#1a2332]`}`}
    >
      <video
        src={message.media_url ?? undefined}
        controls
        playsInline
        preload="auto"
        className={recorded ? 'h-52 w-52 object-cover' : 'max-h-96 max-w-full'}
      />
      <div className="px-4 pb-2 pt-2">
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
  const { conversationId } = useParams<{ conversationId: string }>()
  const [conversation, setConversation] = useState<ConversationData | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  type AvatarStatus = null | 'listening' | 'watching' | 'looking' | 'thinking' | 'writing' | 'recording'
  const [avatarStatus, setAvatarStatus] = useState<AvatarStatus>(null)
  const [captionDraft, setCaptionDraft] = useState<CaptionDraft | null>(null)
  const [captionText, setCaptionText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [transcriptMap, setTranscriptMap] = useState<Record<string, string>>({})
  const [mediaMenuOpen, setMediaMenuOpen] = useState(false)
  const [isDesktopLayout, setIsDesktopLayout] = useState(false)
  const [liveCallState, setLiveCallState] = useState<'idle' | 'starting' | 'joining' | 'active'>('idle')
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
  const sendAvatarReplyRef = useRef<(text: string, options?: { useVoice?: boolean; isVoice?: boolean; perception?: any }) => Promise<void>>(async () => {})

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
    locale,
    conversationId,
    conversation,
    onSending: setSending,
    onError: setError,
    onMessageSent: (msg) => setMessages((current) => [...current, msg as Message]),
    onTranscript: (id, text) => setTranscriptMap((current) => ({ ...current, [id]: text })),
    sendAvatarReply: (...args) => sendAvatarReplyRef.current(...args),
    simulateAvatarRead,
    maybeAvatarReact,
  })

  const {
    videoOverlayOpen, videoOverlayMode, videoPermissionPending,
    videoValidationText, videoValidationTone, videoCanRecord,
    videoPreviewUrl, videoDraftSeconds,
    videoPreviewRef, videoStreamRef, faceValidationIntervalRef,
    openVideoOverlay, closeVideoOverlay,
    startLiveVideoRecording, stopLiveVideoRecording, sendRecordedVideoDraft,
  } = useVideoCapture({
    conversationId,
    conversation,
    shared: {
      setRecordingMode, setCaptureKind, setRecordingSeconds,
      recordTimerRef, speechRecognitionRef, browserTranscriptRef, audioStartRef,
      stopRecordingTimer, startSpeechRecognition,
    },
    onSending: setSending,
    onError: setError,
    onMessageSent: (msg) => setMessages((current) => [...current, msg as Message]),
    onTranscript: (id, text) => setTranscriptMap((current) => ({ ...current, [id]: text })),
    sendAvatarReply: (...args) => sendAvatarReplyRef.current(...args),
  })

  useSessionMemory({
    conversationId,
    ownerId: conversation?.owner_id,
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


  async function getAvatarReply(
    userMessage: string,
    options?: {
      useVoice?: boolean
      imageUrl?: string
      isImage?: boolean
      isVideo?: boolean
      isVoice?: boolean
      perception?: any
    }
  ): Promise<{ content: string; mediaUrl: string | null }> {
    try {
      const {
        useVoice = true,
        imageUrl,
        isImage = false,
        isVideo = false,
        isVoice = false,
        perception,
      } = options ?? {}

      const history = messages
        .slice(-10)
        .map((message) => ({
          role: message.sender === 'contact' ? 'user' : 'assistant',
          content: (message.content || '').trim(),
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
          history,
          image_url: imageUrl,
          isImage,
          isVideo,
          isVoice,
          perception,
        }),
      })

      let replyText = ''
      const chatData = await chatResponse.json().catch(() => ({}))
      if (chatResponse.ok) {
        replyText = typeof chatData?.content === 'string' ? chatData.content.trim() : ''
      } else {
        console.error('[getAvatarReply] Chat API error:', chatData?.error || chatResponse.status)
      }
      if (!replyText) {
        replyText = 'Honestly? Give me the interesting part first.'
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
      const audioBase64 = await blobToBase64(audioBlob)
      const uploadedUrl = await uploadAudioToStorage(conversation!, audioBase64, 'audio/mpeg')

      return {
        content: replyText,
        mediaUrl: uploadedUrl,
      }
    } catch (err) {
      console.error('[getAvatarReply] FAILED:', err)
      return {
        content: 'Sorry, something went wrong generating my response.',
        mediaUrl: null,
      }
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
      perception?: any
    }
  ) {
    if (!conversationId) return
    // Set initial status based on context
    if (options?.isVoice) setAvatarStatus('listening')
    else if (options?.isVideo) setAvatarStatus('watching')
    else if (options?.isImage) setAvatarStatus('looking')
    else setAvatarStatus('thinking')

    try {
      const useVoice = options?.useVoice ?? true
      setAvatarStatus('thinking')
      const replyPayload = await getAvatarReply(seedText, options)
      const hasAudio = useVoice && !!replyPayload.mediaUrl
      const msgType = hasAudio ? 'voice' : 'text'
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
    } catch (err) {
      console.error('Avatar reply failed:', err)
    } finally {
      setAvatarStatus(null)
    }
  }

  // Keep ref in sync for useSessionMemory's nudge callback
  sendAvatarReplyRef.current = sendAvatarReply

  async function handleSendText() {
    if (!text.trim() || !conversationId || sending) return
    const content = text.trim()
    setText('')
    setSending(true)
    setError(null)

    try {
      const message = await sendMessage(conversationId, 'contact', 'text', content)
      setMessages((current) => [...current, message as Message])
      simulateAvatarRead((message as Message).id)
      await sendAvatarReply(content, { useVoice: false })
      maybeAvatarReact((message as Message).id)
    } catch (sendError: any) {
      console.error(sendError)
      setError(sendError?.message || 'Unable to send your message.')
    } finally {
      setSending(false)
    }
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
        await sendAvatarReply(caption || 'The user shared this image.', {
          useVoice: true,
          imageUrl: mediaUrl,
          isImage: true,
        })
        maybeAvatarReact((message as Message).id)
        return
      }

      setAvatarStatus('watching')
      const rotatedFile = await correctVideoOrientation(file)
      const metadata = await readVideoMetadata(rotatedFile)
      const [mediaUrl, opmResponse] = await Promise.all([
        uploadMediaToStorage(conversation!, rotatedFile, 'video'),
        callOpmApi(conversation!, rotatedFile, 'video').catch((error) => {
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
      const transcript = opmResponse?.transcript?.trim() || ''
      const videoMessageText = caption
        ? (transcript ? `${caption}\n\n[Transcribed from video]: ${transcript}` : caption)
        : transcript || 'an uploaded video'
      await sendAvatarReply(videoMessageText, {
        useVoice: false,
        isVideo: true,
        perception: opmResponse,
      })
      maybeAvatarReact((message as Message).id)
    } catch (draftError) {
      console.error(draftError)
      setError(`Unable to send this ${kind}.`)
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

  async function openLiveCall() {
    if (liveCallState !== 'idle') return
    setLiveCallState('starting')
    try {
      // Sync persona – include layers config so Tavus enables microphone input
      await fetch(`${BOARDROOM_API_BASE}/api/tavus/personas/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          persona_id: LIVE_CALL_PERSONA_ID,
          persona_name: `${owner.display_name} Live`,
          default_replica_id: owner.tavus_replica_id || LIVE_CALL_REPLICA_ID,
          system_prompt: owner.system_prompt?.trim() || `You are ${owner.display_name} in a live WhatsAnima video call. Stay conversational and present.`,
          layers: {
            transport: {
              input_settings: {
                microphone: 'enabled',
              },
            },
            tts: {
              tts_engine: 'elevenlabs',
              voice_id: owner.voice_id || 'lx8LAX2EUAKftVz0Dk5z',
              model_id: 'eleven_multilingual_v2',
            },
          },
        }),
      })

      // Create conversation
      setLiveCallState('joining')
      const convRes = await fetch(`${BOARDROOM_API_BASE}/api/tavus/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          persona_id: LIVE_CALL_PERSONA_ID,
          replica_id: owner.tavus_replica_id || LIVE_CALL_REPLICA_ID,
          properties: {
            enable_recording: false,
            apply_greenscreen: false,
            language: 'multi',
          },
        }),
      })

      if (!convRes.ok) throw new Error('Failed to create video call')
      const convData = await convRes.json()
      const joinUrl = convData.conversation_url || convData.url
      if (joinUrl) {
        window.open(joinUrl, '_blank')
        setLiveCallState('active')
        setTimeout(() => setLiveCallState('idle'), 5000)
      } else {
        throw new Error('No join URL returned')
      }
    } catch (err) {
      console.error('[LiveCall] Error:', err)
      setError('Unable to start video call.')
      setLiveCallState('idle')
    }
  }

  return (
    <div className="relative flex h-[100svh] min-h-[100svh] flex-col overflow-hidden bg-[linear-gradient(140deg,_#020a12_0%,_#071420_35%,_#060e1a_65%,_#030810_100%)] text-white">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(0,168,132,0.12),transparent_60%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_40%_at_80%_20%,rgba(56,169,255,0.07),transparent_50%)]" />
      {isDesktopLayout && <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(126,255,234,0.015)_1px,transparent_1px),linear-gradient(90deg,rgba(126,255,234,0.015)_1px,transparent_1px)] bg-[size:40px_40px]" />}
      <div className={`relative z-10 flex min-h-0 flex-1 flex-col ${isDesktopLayout ? 'mx-auto my-6 w-[min(900px,calc(100vw-80px))] overflow-hidden rounded-[28px] border border-white/[0.06] bg-[rgba(6,14,22,0.88)] shadow-[0_40px_160px_rgba(0,0,0,0.55),0_0_0_1px_rgba(255,255,255,0.03)] backdrop-blur-3xl' : ''}`}>
      <header className={`relative z-10 flex items-center gap-3 border-b border-white/[0.06] px-4 py-3 backdrop-blur-2xl ${isDesktopLayout ? 'bg-[rgba(8,18,28,0.65)] shadow-[0_1px_0_rgba(255,255,255,0.03)]' : 'bg-[#0a1420]/80 shadow-[0_8px_32px_rgba(0,0,0,0.2)]'}`}>
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
            {/* Export full chat button */}
            <div className="relative">
              <button type="button" onClick={() => setExportMenuOpen((c) => !c)} title={t(locale, 'exportChat')} className="flex h-11 w-11 items-center justify-center rounded-full border border-white/8 bg-white/[0.04] text-[#9af8ea] transition hover:border-[#74f0df]/30 hover:text-white">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" /></svg>
              </button>
              {exportMenuOpen && (
                <div className="absolute right-0 top-14 z-50 w-56 rounded-2xl border border-white/10 bg-[linear-gradient(180deg,rgba(17,29,44,0.98),rgba(10,20,33,0.99))] p-2 shadow-[0_24px_80px_rgba(0,0,0,0.4)] backdrop-blur-2xl">
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
            <button
              type="button"
              onClick={() => void openLiveCall()}
              disabled={liveCallState === 'starting' || liveCallState === 'joining'}
              className="flex h-11 w-11 items-center justify-center rounded-full border border-[#74f0df]/25 bg-[linear-gradient(180deg,rgba(12,136,109,0.34),rgba(7,76,79,0.42))] text-[#9af8ea] shadow-[0_0_30px_rgba(48,214,193,0.18)] transition hover:border-[#74f0df]/50 hover:text-white disabled:opacity-50"
              title="Start live video call"
            >
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M17 10.5V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-3.5l4 4v-11l-4 4z" />
              </svg>
            </button>
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
                  <span className="font-medium text-white/60">{owner.display_name}</span>
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
                  <span className="font-medium text-white/70">{owner.display_name}</span>
                  {' '}
                  {avatarStatus === 'listening' ? t(locale, 'isListening')
                    : avatarStatus === 'watching' ? t(locale, 'isWatching')
                    : avatarStatus === 'looking' ? t(locale, 'isLooking')
                    : avatarStatus === 'thinking' ? t(locale, 'isThinking')
                    : avatarStatus === 'writing' ? t(locale, 'isWriting')
                    : avatarStatus === 'recording' ? t(locale, 'isRecording')
                    : t(locale, 'isWriting')}
                </span>
              </div>
            </div>
          ) : null}

          <div ref={messagesEndRef} />
        </div>
      </main>

      {error ? (
        <div className="relative z-10 border-t border-white/8 bg-[#101b28]/88 px-4 py-2 text-center text-sm text-red-300 backdrop-blur-xl">{error}</div>
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
        <div className="absolute inset-0 z-30 bg-[#000d]">
          <div className="flex h-full w-full flex-col items-center justify-between px-4 pb-[calc(env(safe-area-inset-bottom)+20px)] pt-[calc(env(safe-area-inset-top)+20px)]">
            <div className="flex w-full max-w-5xl items-center justify-between">
              <button type="button" onClick={closeVideoOverlay} className="rounded-full bg-white/8 px-4 py-2 text-sm text-white backdrop-blur">
                Cancel
              </button>
              <div className="rounded-full bg-black/35 px-4 py-2 text-sm font-medium text-white/90 backdrop-blur">
                {formatClock(videoOverlayMode === 'preview' ? videoDraftSeconds : recordingSeconds)}
              </div>
            </div>

            <div className="flex flex-1 flex-col items-center justify-center">
              <div className={`relative flex items-center justify-center overflow-hidden border border-white/10 bg-[#07111c] shadow-[0_30px_120px_rgba(0,0,0,0.46)] ${isDesktopLayout ? 'h-[420px] w-[420px] rounded-full' : 'h-[300px] w-[300px] rounded-full'}`}>
                {videoOverlayMode === 'preview' && videoPreviewUrl ? (
                  <video src={videoPreviewUrl} autoPlay loop controls playsInline className="h-full w-full object-cover" />
                ) : (
                  <video ref={videoPreviewRef} autoPlay muted playsInline className="-scale-x-100 h-full w-full object-cover" />
                )}
                <div className="pointer-events-none absolute inset-[10%] rounded-full border border-white/12 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]" />
                {videoPermissionPending ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/28 backdrop-blur-sm">
                    <span className="rounded-full bg-black/40 px-4 py-2 text-sm text-white/85">Waiting for camera permission…</span>
                  </div>
                ) : null}
              </div>
              <div className={`mt-6 rounded-full px-4 py-2 text-sm backdrop-blur ${videoValidationTone === 'error' ? 'bg-red-500/18 text-red-200' : videoValidationTone === 'warning' ? 'bg-amber-400/14 text-amber-100' : videoValidationTone === 'success' ? 'bg-emerald-400/14 text-emerald-100' : 'bg-black/28 text-white/80'}`}>
                {videoValidationText}
              </div>
            </div>

            <div className="flex w-full max-w-5xl items-center justify-center gap-4">
              {videoOverlayMode === 'preview' ? (
                <>
                  <button
                    type="button"
                    onClick={closeVideoOverlay}
                    className="rounded-full border border-white/10 bg-white/6 px-5 py-3 text-sm font-semibold text-white/80 backdrop-blur"
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    onClick={() => void sendRecordedVideoDraft()}
                    disabled={sending}
                    className="rounded-full bg-gradient-to-r from-[#11c2a0] to-[#38a9ff] px-6 py-3 text-sm font-semibold text-white shadow-[0_0_36px_rgba(42,196,231,0.22)] disabled:opacity-40"
                  >
                    Send video
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => void (recordingMode !== 'idle' ? stopLiveVideoRecording() : startLiveVideoRecording())}
                  disabled={videoPermissionPending || (!videoCanRecord && recordingMode === 'idle')}
                  className={`flex h-20 w-20 items-center justify-center rounded-full border-4 ${recordingMode !== 'idle' ? 'border-[#ff6b7f] bg-[#ff6b7f]/24' : 'border-white/85 bg-white/10'} shadow-[0_0_40px_rgba(255,255,255,0.12)] disabled:opacity-40`}
                >
                  {recordingMode !== 'idle' ? (
                    <div className="h-6 w-6 rounded-md bg-[#ff6b7f]" />
                  ) : (
                    <div className="h-14 w-14 rounded-full bg-white" />
                  )}
                </button>
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
