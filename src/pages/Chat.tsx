import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import DailyIframe from '@daily-co/daily-js'
import { useParams } from 'react-router-dom'
import { createPerceptionLog, getConversation, listMessages, listPerceptionLogs, sendMessage } from '../lib/api'

type MessageType = 'text' | 'voice' | 'video' | 'image'

interface Message {
  id: string
  sender: 'contact' | 'avatar'
  type: MessageType
  content: string | null
  media_url: string | null
  duration_sec: number | null
  created_at: string
}

interface ConversationData {
  id: string
  owner_id: string
  contact_id: string
  wa_owners: {
    id?: string
    display_name: string
    avatar_url: string | null
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

type RecordingMode = 'idle' | 'recording' | 'stopping'
type CaptureKind = 'none' | 'voice' | 'video'
type VideoOverlayMode = 'live' | 'preview'
type ValidationTone = '' | 'warning' | 'success' | 'error'
type LiveCallState = 'idle' | 'starting' | 'joining' | 'connected' | 'error'

interface DailyParticipantTrack {
  persistentTrack?: MediaStreamTrack | null
}

interface DailyParticipant {
  local?: boolean
  session_id?: string
  user_name?: string
  userName?: string
  tracks?: {
    video?: DailyParticipantTrack
  }
}

interface BrowserSpeechRecognitionResult {
  isFinal: boolean
  0: { transcript: string }
}

interface BrowserSpeechRecognitionEvent {
  resultIndex: number
  results: ArrayLike<BrowserSpeechRecognitionResult>
}

interface BrowserSpeechRecognition {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null
  start(): void
  stop(): void
}

declare global {
  interface Window {
    SpeechRecognition?: {
      new (): BrowserSpeechRecognition
    }
    webkitSpeechRecognition?: {
      new (): BrowserSpeechRecognition
    }
  }
}

const WAVEFORM_BARS = Array.from({ length: 15 }, (_, index) => index)
const BOARDROOM_API_BASE =
  (import.meta.env.VITE_BOARDROOM_API_BASE as string | undefined)?.replace(/\/$/, '') || 'https://boardroom-api.onioko.com'
const LIVE_CALL_REPLICA_ID = 'rf5414018e80'
const LIVE_CALL_PERSONA_ID = 'pipecat-stream'
const DEFAULT_LIVE_CALL_PROMPT = 'You are the avatar in a live WhatsAnima video call. Stay conversational and present.'

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

  if (dateKey(date.toISOString()) === dateKey(today.toISOString())) return 'Today'
  if (dateKey(date.toISOString()) === dateKey(yesterday.toISOString())) return 'Yesterday'

  return date.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  })
}

function getFileExtension(file: Blob & { name?: string; type: string }, fallback: string) {
  const byMime: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/webm;codecs=opus': 'webm',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/aac': 'aac',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
  }
  const fromMime = byMime[file.type]
  if (fromMime) return fromMime
  const fromName = file.name?.split('.').pop()?.toLowerCase()
  return fromName || fallback
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('Unable to read file'))
        return
      }
      resolve(result.split(',')[1] || '')
    }
    reader.onerror = () => reject(new Error('Unable to read file'))
    reader.readAsDataURL(blob)
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

function getParticipantName(participant: DailyParticipant | null | undefined, fallback: string) {
  return participant?.user_name || participant?.userName || fallback
}

function pickRemoteParticipant(participants: Record<string, DailyParticipant>) {
  const remotes = Object.values(participants).filter((participant) => participant.local !== true)
  return remotes.find((participant) => participant.tracks?.video?.persistentTrack) || remotes[0] || null
}

function syncVideoTrack(element: HTMLVideoElement | null, participant: DailyParticipant | null, muted: boolean) {
  if (!element) return

  const track = participant?.tracks?.video?.persistentTrack
  element.muted = muted
  element.playsInline = true
  element.autoplay = true

  if (!track) {
    element.pause()
    element.srcObject = null
    return
  }

  const currentStream = element.srcObject instanceof MediaStream ? element.srcObject : null
  const currentTrack = currentStream?.getVideoTracks()[0] || null
  if (currentTrack?.id === track.id) return

  const stream = new MediaStream([track])
  element.srcObject = stream
  void element.play().catch(() => undefined)
}

const VoiceMessageBubble = memo(function VoiceMessageBubble({
  isContact,
  message,
  transcript,
}: {
  isContact: boolean
  message: Message
  transcript?: string
}) {
  const [isTranscriptOpen, setIsTranscriptOpen] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [displaySeconds, setDisplaySeconds] = useState(message.duration_sec ?? 0)
  const [durationSeconds, setDurationSeconds] = useState(message.duration_sec ?? 0)
  const [progress, setProgress] = useState(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)

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

  const togglePlay = async () => {
    if (!message.media_url) return

    if (!audioRef.current) {
      const audio = new Audio(message.media_url)
      audio.preload = 'metadata'
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
      audio.onerror = () => {
        setIsPlaying(false)
      }
      audioRef.current = audio
    }

    const audio = audioRef.current
    if (audio.paused) {
      await audio.play().catch(() => undefined)
      setIsPlaying(true)
    } else {
      audio.pause()
      setIsPlaying(false)
    }
  }

  return (
    <div
      className={`relative max-w-[84%] rounded-[24px] border px-3 py-2.5 text-sm shadow-[0_18px_50px_rgba(0,0,0,0.18)] backdrop-blur-xl ${
        isContact
          ? 'rounded-tr-md border-[#47dfc2]/20 bg-[linear-gradient(180deg,rgba(8,118,100,0.9),rgba(5,86,79,0.92))] text-white'
          : 'rounded-tl-md border-white/8 bg-[linear-gradient(180deg,rgba(22,34,51,0.86),rgba(12,24,39,0.92))] text-white'
      }`}
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          disabled={!hasPlayableAudio}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/8 bg-white/8 text-white disabled:opacity-40"
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
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {WAVEFORM_BARS.map((bar) => (
            <span
              key={bar}
              className={`w-1 rounded-full transition-all ${
                (bar + 1) / WAVEFORM_BARS.length <= progress ? 'bg-[#7be3ce]' : 'bg-white/30'
              }`}
              style={{ height: `${[6, 12, 18, 10, 22, 14, 8, 20, 12, 16, 24, 10, 18, 8, 14][bar]}px` }}
            />
          ))}
        </div>
        <span className="text-xs text-white/70">{formatClock(isPlaying ? displaySeconds : durationSeconds)}</span>
      </div>
      {hasTranscript ? (
        <button
          type="button"
          onClick={() => setIsTranscriptOpen((current) => !current)}
          className="mt-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-white/80 transition hover:border-white/25"
        >
          {isTranscriptOpen ? 'Hide transcript' : 'Transcribe'}
        </button>
      ) : null}
      {hasTranscript && isTranscriptOpen ? (
        <div className="mt-2 rounded-2xl bg-black/15 px-3 py-2 text-sm text-white/84">{transcript}</div>
      ) : null}
      <span className="mt-1 block text-right text-[10px] text-white/45">{formatMessageTime(message.created_at)}</span>
    </div>
  )
})

const MediaMessageBubble = memo(function MediaMessageBubble({
  isContact,
  message,
}: {
  isContact: boolean
  message: Message
}) {
  if (!message.media_url) return null

  const commonMeta = (
    <span className="mt-2 block text-right text-[10px] text-white/45">{formatMessageTime(message.created_at)}</span>
  )

  if (message.type === 'image') {
    return (
      <div
        className={`relative max-w-[84%] rounded-[26px] border p-1.5 shadow-[0_18px_50px_rgba(0,0,0,0.18)] backdrop-blur-xl ${
          isContact
            ? 'rounded-tr-md border-[#47dfc2]/20 bg-[linear-gradient(180deg,rgba(8,118,100,0.9),rgba(5,86,79,0.92))] text-white'
            : 'rounded-tl-md border-white/8 bg-[linear-gradient(180deg,rgba(22,34,51,0.86),rgba(12,24,39,0.92))] text-white'
        }`}
      >
        <img src={message.media_url} alt="Shared image" className="max-h-80 rounded-[18px] object-cover" />
        {!isPlaceholderContent(message) ? (
          <div className="px-2 pb-1 pt-2 text-sm text-white">{message.content}</div>
        ) : null}
        <div className="px-2 pb-1">{commonMeta}</div>
      </div>
    )
  }

  const recorded = isRecordedVideoMessage(message)
  return (
    <div
      className={`relative max-w-[84%] overflow-hidden border shadow-[0_18px_50px_rgba(0,0,0,0.18)] backdrop-blur-xl ${
        recorded ? 'rounded-full' : 'rounded-2xl'
      } ${isContact
        ? 'border-[#47dfc2]/20 bg-[linear-gradient(180deg,rgba(8,118,100,0.9),rgba(5,86,79,0.92))] text-white'
        : 'border-white/8 bg-[linear-gradient(180deg,rgba(22,34,51,0.86),rgba(12,24,39,0.92))] text-white'}`}
    >
      <video
        src={message.media_url}
        controls
        playsInline
        preload="metadata"
        className={recorded ? 'h-52 w-52 object-cover' : 'max-h-96 max-w-full rounded-t-2xl'}
      />
      <div className="px-3 pb-2 pt-2">
        {!isPlaceholderContent(message) ? <div className="text-sm text-white">{message.content}</div> : null}
        <div className="mt-1 flex items-center justify-between gap-4 text-[10px] text-white/50">
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
  const [avatarTyping, setAvatarTyping] = useState(false)
  const [recordingMode, setRecordingMode] = useState<RecordingMode>('idle')
  const [captureKind, setCaptureKind] = useState<CaptureKind>('none')
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [captionDraft, setCaptionDraft] = useState<CaptionDraft | null>(null)
  const [captionText, setCaptionText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [transcriptMap, setTranscriptMap] = useState<Record<string, string>>({})
  const [mediaMenuOpen, setMediaMenuOpen] = useState(false)
  const [voiceOverlayOpen, setVoiceOverlayOpen] = useState(false)
  const [voiceDraftUrl, setVoiceDraftUrl] = useState<string | null>(null)
  const [voiceDraftReady, setVoiceDraftReady] = useState(false)
  const [voiceDraftSeconds, setVoiceDraftSeconds] = useState(0)
  const [voiceDraftTranscript, setVoiceDraftTranscript] = useState('')
  const [videoOverlayOpen, setVideoOverlayOpen] = useState(false)
  const [videoOverlayMode, setVideoOverlayMode] = useState<VideoOverlayMode>('live')
  const [videoPermissionPending, setVideoPermissionPending] = useState(false)
  const [videoValidationText, setVideoValidationText] = useState('Position your face in the circle')
  const [videoValidationTone, setVideoValidationTone] = useState<ValidationTone>('')
  const [videoCanRecord, setVideoCanRecord] = useState(false)
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null)
  const [videoDraftSeconds, setVideoDraftSeconds] = useState(0)
  const [isDesktopLayout, setIsDesktopLayout] = useState(false)
  const [liveCallOpen, setLiveCallOpen] = useState(false)
  const [liveCallState, setLiveCallState] = useState<LiveCallState>('idle')
  const [liveCallError, setLiveCallError] = useState<string | null>(null)
  const [liveCallRoomUrl, setLiveCallRoomUrl] = useState('')
  const [liveLocalParticipant, setLiveLocalParticipant] = useState<DailyParticipant | null>(null)
  const [liveRemoteParticipant, setLiveRemoteParticipant] = useState<DailyParticipant | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const audioRecorderRef = useRef<MediaRecorder | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const audioStartRef = useRef(0)
  const audioStopResolverRef = useRef<((blob: Blob | null) => void) | null>(null)
  const recordTimerRef = useRef<number | null>(null)
  const speechRecognitionRef = useRef<BrowserSpeechRecognition | null>(null)
  const browserTranscriptRef = useRef('')
  const videoRecorderRef = useRef<MediaRecorder | null>(null)
  const videoStreamRef = useRef<MediaStream | null>(null)
  const videoChunksRef = useRef<Blob[]>([])
  const videoPreviewRef = useRef<HTMLVideoElement>(null)
  const faceCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const videoValidationLockRef = useRef(0)
  const lastVideoValidationRef = useRef('')
  const voiceDraftBlobRef = useRef<Blob | null>(null)
  const videoDraftBlobRef = useRef<Blob | null>(null)
  const faceValidationIntervalRef = useRef<number | null>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const liveCallRef = useRef<ReturnType<typeof DailyIframe.createCallObject> | null>(null)
  const liveLocalVideoRef = useRef<HTMLVideoElement | null>(null)
  const liveRemoteVideoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    if (!conversationId) return

    setLoading(true)
    Promise.all([
      getConversation(conversationId),
      listMessages(conversationId),
      listPerceptionLogs(conversationId),
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
      })
      .catch((loadError) => {
        console.error(loadError)
        setError('Unable to load this conversation.')
      })
      .finally(() => setLoading(false))
  }, [conversationId])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, avatarTyping])

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

  useEffect(() => {
    syncVideoTrack(liveRemoteVideoRef.current, liveRemoteParticipant, false)
  }, [liveRemoteParticipant])

  useEffect(() => {
    syncVideoTrack(liveLocalVideoRef.current, liveLocalParticipant, true)
  }, [liveLocalParticipant])

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

  function updateLiveParticipants(participants: Record<string, DailyParticipant>) {
    const local = Object.values(participants).find((participant) => participant.local === true) || null
    const remote = pickRemoteParticipant(participants)
    setLiveLocalParticipant(local)
    setLiveRemoteParticipant(remote)
  }

  async function teardownLiveCall() {
    const call = liveCallRef.current
    liveCallRef.current = null

    setLiveLocalParticipant(null)
    setLiveRemoteParticipant(null)
    setLiveCallRoomUrl('')

    if (!call) return

    try {
      await call.leave()
    } catch {
      // Ignore leave errors while tearing down the room UI.
    }

    try {
      await call.destroy()
    } catch {
      // Ignore destroy errors after the call has ended.
    }
  }

  async function closeLiveCall() {
    await teardownLiveCall()
    setLiveCallOpen(false)
    setLiveCallState('idle')
    setLiveCallError(null)
  }

  async function syncLivePersona() {
    const response = await fetch(`${BOARDROOM_API_BASE}/api/tavus/personas/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        persona_id: LIVE_CALL_PERSONA_ID,
        persona_name: `${conversation?.wa_owners.display_name || 'WhatsAnima'} Live`,
        default_replica_id: LIVE_CALL_REPLICA_ID,
        system_prompt: conversation?.wa_owners.system_prompt?.trim() || DEFAULT_LIVE_CALL_PROMPT,
        pipeline_mode: 'full',
      }),
    })

    if (response.ok) return

    let detail = 'Unable to prepare the live avatar.'
    try {
      const payload = await response.json()
      if (typeof payload?.detail === 'string' && payload.detail.trim()) detail = payload.detail
    } catch {
      const text = await response.text().catch(() => '')
      if (text.trim()) detail = text.trim()
    }
    throw new Error(detail)
  }

  async function createLiveConversationRoom() {
    const response = await fetch(`${BOARDROOM_API_BASE}/api/tavus/conversations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        persona_id: LIVE_CALL_PERSONA_ID,
        replica_id: LIVE_CALL_REPLICA_ID,
        conversation_name: `${conversation?.wa_owners.display_name || 'WhatsAnima'} Live Call`,
      }),
    })

    if (!response.ok) {
      let detail = 'Unable to create the live room.'
      try {
        const payload = await response.json()
        if (typeof payload?.detail === 'string' && payload.detail.trim()) detail = payload.detail
      } catch {
        const text = await response.text().catch(() => '')
        if (text.trim()) detail = text.trim()
      }
      throw new Error(detail)
    }

    const payload = (await response.json()) as {
      conversation_url?: string
      url?: string
    }
    const roomUrl = payload.conversation_url || payload.url || ''
    if (!roomUrl) throw new Error('Live room URL missing from Tavus response.')
    return roomUrl
  }

  async function openLiveCall() {
    if (!conversation) return

    setLiveCallOpen(true)
    setLiveCallState('starting')
    setLiveCallError(null)

    try {
      await teardownLiveCall()
      await syncLivePersona()

      const roomUrl = await createLiveConversationRoom()
      setLiveCallRoomUrl(roomUrl)
      setLiveCallState('joining')

      const call = DailyIframe.createCallObject()
      liveCallRef.current = call

      const refreshParticipants = () => {
        updateLiveParticipants(call.participants() as Record<string, DailyParticipant>)
      }

      call.on('joined-meeting', refreshParticipants)
      call.on('participant-joined', refreshParticipants)
      call.on('participant-updated', refreshParticipants)
      call.on('participant-left', refreshParticipants)
      call.on('left-meeting', () => {
        setLiveCallState('idle')
        setLiveCallOpen(false)
        setLiveCallError(null)
        setLiveLocalParticipant(null)
        setLiveRemoteParticipant(null)
        setLiveCallRoomUrl('')
      })
      call.on('error', (event: { errorMsg?: string }) => {
        setLiveCallState('error')
        setLiveCallError(event.errorMsg || 'Live call connection failed.')
      })
      call.on('camera-error', (event: { errorMsg?: { errorMsg?: string } | string }) => {
        const errorMsg =
          typeof event.errorMsg === 'string'
            ? event.errorMsg
            : event.errorMsg?.errorMsg || 'Camera or microphone access failed.'
        setLiveCallState('error')
        setLiveCallError(errorMsg)
      })

      await call.join({
        url: roomUrl,
        userName: conversation.wa_contacts.display_name || 'Guest',
        startVideoOff: false,
        startAudioOff: false,
      })

      await call.setLocalVideo(true)
      await call.setLocalAudio(true)
      refreshParticipants()
      setLiveCallState('connected')
    } catch (liveCallOpenError) {
      await teardownLiveCall()
      setLiveCallState('error')
      setLiveCallError(
        liveCallOpenError instanceof Error ? liveCallOpenError.message : 'Unable to start the live call.'
      )
    }
  }

  useEffect(() => {
    return () => {
      void teardownLiveCall()
    }
  }, [])

  async function uploadAudioToStorage(audioBase64: string, mimeType: string) {
    if (!conversation) return null

    const response = await fetch('/api/upload-audio', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio_base64: audioBase64,
        owner_id: conversation.owner_id,
        conversation_id: conversation.id,
        mime_type: mimeType,
      }),
    })

    const data = await response.json().catch(() => ({}))
    return typeof data.audio_url === 'string' ? data.audio_url : null
  }

  async function uploadMediaToStorage(file: File, mediaType: 'image' | 'video') {
    if (!conversation) return null

    const mediaBase64 = await blobToBase64(file)
    const response = await fetch('/api/upload-media', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        media_base64: mediaBase64,
        owner_id: conversation.owner_id,
        conversation_id: conversation.id,
        mime_type: file.type,
        media_type: mediaType,
      }),
    })

    const data = await response.json().catch(() => ({}))
    return typeof data.url === 'string' ? data.url : null
  }

  async function getAvatarReply(
    userMessage: string,
    options?: {
      useVoice?: boolean
      imageUrl?: string
      isImage?: boolean
      isVideo?: boolean
      isVoice?: boolean
    }
  ): Promise<{ content: string; mediaUrl: string | null }> {
    try {
      const {
        useVoice = true,
        imageUrl,
        isImage = false,
        isVideo = false,
        isVoice = false,
      } = options ?? {}

      const history = messages
        .slice(-10)
        .map((message) => ({
          role: message.sender === 'contact' ? 'user' : 'assistant',
          content: (message.content || '').trim(),
        }))
        .filter((message) => message.content.length > 0)

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
        }),
      })

      const chatData = await chatResponse.json().catch(() => ({}))
      let replyText = typeof chatData?.content === 'string' ? chatData.content.trim() : ''
      if (!chatResponse.ok) {
        const apiError = chatData?.error || `API error ${chatResponse.status}`
        console.error('[Chat] API error:', apiError)
        replyText = replyText || `Sorry, the AI is temporarily unavailable (${apiError}).`
      }
      if (!replyText) {
        replyText = 'Honestly? Give me the interesting part first.'
      }

      if (!useVoice) {
        return { content: replyText, mediaUrl: null }
      }

      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: replyText,
        }),
      })

      if (!response.ok) {
        return {
          content: replyText,
          mediaUrl: null,
        }
      }

      const data = await response.json().catch(() => ({}))
      const audioBase64 = typeof data.audio === 'string' ? data.audio : ''
      if (!audioBase64) {
        return { content: replyText, mediaUrl: null }
      }
      const uploadedUrl = await uploadAudioToStorage(audioBase64, data.content_type || 'audio/mpeg')

      return {
        content: replyText,
        mediaUrl: uploadedUrl,
      }
    } catch {
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
    }
  ) {
    if (!conversationId) return
    setAvatarTyping(true)
    try {
      const useVoice = options?.useVoice ?? true
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
    } catch (err) {
      console.error('Avatar reply failed:', err)
    } finally {
      setAvatarTyping(false)
    }
  }

  async function handleSendText() {
    if (!text.trim() || !conversationId || sending) return
    const content = text.trim()
    setText('')
    setSending(true)
    setError(null)

    try {
      const message = await sendMessage(conversationId, 'contact', 'text', content)
      setMessages((current) => [...current, message as Message])
      await sendAvatarReply(content, { useVoice: false })
    } catch (sendError) {
      console.error('[Chat] send error:', sendError)
      setError(sendError instanceof Error ? sendError.message : 'Unable to send your message.')
    } finally {
      setSending(false)
    }
  }

  async function sendVoiceMessage(blob: Blob, transcript: string, durationSeconds: number) {
    if (!conversationId || !conversation) return

    const file = new File([blob], `voice-note.${getFileExtension(blob, 'webm')}`, {
      type: blob.type || 'audio/webm',
    })

    setSending(true)
    setError(null)
    try {
      const audioBase64 = await blobToBase64(file)
      const mediaUrl = await uploadAudioToStorage(audioBase64, file.type || 'audio/webm')
      if (!mediaUrl) throw new Error('upload failed')

      const message = (await sendMessage(
        conversationId,
        'contact',
        'voice',
        transcript || '[Voice message]',
        mediaUrl,
        durationSeconds
      )) as Message

      setMessages((current) => [...current, message])

      if (transcript) {
        await createPerceptionLog({
          messageId: message.id,
          conversationId: conversation.id,
          contactId: conversation.contact_id,
          ownerId: conversation.owner_id,
          transcript,
          audioDurationSec: durationSeconds,
        })
        setTranscriptMap((current) => ({ ...current, [message.id]: transcript }))
      }

      await sendAvatarReply(transcript || 'a voice message', { isVoice: true })
    } catch (recordingError) {
      console.error(recordingError)
      setError('Unable to send this voice note.')
    } finally {
      setSending(false)
    }
  }

  function stopRecordingTimer() {
    if (recordTimerRef.current) {
      window.clearInterval(recordTimerRef.current)
      recordTimerRef.current = null
    }
  }

  function startSpeechRecognition() {
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition

    if (!SpeechRecognitionCtor) return

    try {
      const recognition = new SpeechRecognitionCtor()
      recognition.continuous = true
      recognition.interimResults = false
      recognition.lang = 'en-US'
      recognition.onresult = (event: BrowserSpeechRecognitionEvent) => {
        let nextTranscript = browserTranscriptRef.current
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index]
          if (result.isFinal) nextTranscript += `${result[0].transcript} `
        }
        browserTranscriptRef.current = nextTranscript
      }
      recognition.start()
      speechRecognitionRef.current = recognition
    } catch {
      speechRecognitionRef.current = null
    }
  }

  async function startVoiceRecording() {
    if (recordingMode !== 'idle') return

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeTypeOptions = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', '']
      const supportedMimeType = mimeTypeOptions.find((option) => option === '' || MediaRecorder.isTypeSupported(option)) || ''
      const recorder = supportedMimeType ? new MediaRecorder(stream, { mimeType: supportedMimeType }) : new MediaRecorder(stream)

      audioStreamRef.current = stream
      audioRecorderRef.current = recorder
      audioChunksRef.current = []
      browserTranscriptRef.current = ''
      audioStartRef.current = Date.now()
      setRecordingSeconds(0)
      setRecordingMode('recording')
      setCaptureKind('voice')

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        const blob = audioChunksRef.current.length
          ? new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' })
          : null
        audioStreamRef.current?.getTracks().forEach((track) => track.stop())
        audioStreamRef.current = null
        audioRecorderRef.current = null
        audioStopResolverRef.current?.(blob)
        audioStopResolverRef.current = null
      }

      recorder.start(100)
      startSpeechRecognition()

      recordTimerRef.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - audioStartRef.current) / 1000)
        setRecordingSeconds(elapsed)
      }, 250)
    } catch (startError) {
      console.error(startError)
      setRecordingMode('idle')
      setError('Microphone access is required to record voice notes.')
    }
  }

  async function finishVoiceRecording(action: 'send' | 'draft' | 'cancel' = 'send') {
    if (recordingMode === 'idle') return

    setRecordingMode('stopping')
    stopRecordingTimer()
    speechRecognitionRef.current?.stop?.()
    speechRecognitionRef.current = null

    const blobPromise = new Promise<Blob | null>((resolve) => {
      audioStopResolverRef.current = resolve
    })

    if (audioRecorderRef.current && audioRecorderRef.current.state !== 'inactive') {
      audioRecorderRef.current.stop()
    } else {
      audioStopResolverRef.current?.(null)
    }

    const blob = await blobPromise
    setRecordingMode('idle')
    setCaptureKind('none')
    setRecordingSeconds(0)

    const durationSeconds = Math.max(1, Math.round((Date.now() - audioStartRef.current) / 1000))
    const transcript = browserTranscriptRef.current.trim()
    browserTranscriptRef.current = ''

    if (!blob || action === 'cancel') return
    if (action === 'draft') {
      voiceDraftBlobRef.current = blob
      setVoiceDraftTranscript(transcript)
      setVoiceDraftSeconds(durationSeconds)
      setVoiceDraftReady(true)
      setVoiceDraftUrl((current) => {
        if (current) URL.revokeObjectURL(current)
        return URL.createObjectURL(blob)
      })
      return
    }

    await sendVoiceMessage(blob, transcript, durationSeconds)
  }

  async function startLiveVideoRecording() {
    if (!conversation || !videoStreamRef.current) return

    try {
      const mimeTypeOptions = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
      const mimeType = mimeTypeOptions.find((option) => MediaRecorder.isTypeSupported(option)) || ''
      const recorder = mimeType ? new MediaRecorder(videoStreamRef.current, { mimeType }) : new MediaRecorder(videoStreamRef.current)
      videoRecorderRef.current = recorder
      videoChunksRef.current = []

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) videoChunksRef.current.push(event.data)
      }
      recorder.start(250)
      setRecordingMode('recording')
      setCaptureKind('video')
      audioStartRef.current = Date.now()
      stopRecordingTimer()
      if (faceValidationIntervalRef.current) {
        window.clearInterval(faceValidationIntervalRef.current)
        faceValidationIntervalRef.current = null
      }
      setVideoValidationText('Recording...')
      setVideoValidationTone('')
      recordTimerRef.current = window.setInterval(() => {
        setRecordingSeconds(Math.floor((Date.now() - audioStartRef.current) / 1000))
      }, 250)
    } catch (videoError) {
      console.error(videoError)
      setError('Camera access is required to record video.')
    }
  }

  async function stopLiveVideoRecording() {
    if (!videoRecorderRef.current || !conversation || !conversationId) return

    stopRecordingTimer()
    if (faceValidationIntervalRef.current) {
      window.clearInterval(faceValidationIntervalRef.current)
      faceValidationIntervalRef.current = null
    }
    setRecordingMode('stopping')

    const blob = await new Promise<Blob | null>((resolve) => {
      const recorder = videoRecorderRef.current
      if (!recorder) {
        resolve(null)
        return
      }

      recorder.onstop = () => {
        const output = videoChunksRef.current.length
          ? new Blob(videoChunksRef.current, { type: recorder.mimeType || 'video/webm' })
          : null
        videoStreamRef.current?.getTracks().forEach((track) => track.stop())
        videoStreamRef.current = null
        videoRecorderRef.current = null
        resolve(output)
      }
      recorder.stop()
    })

    setRecordingMode('idle')
    setCaptureKind('none')
    setRecordingSeconds(0)

    if (!blob) return

    const file = new File([blob], `recorded-video.${getFileExtension(blob, 'webm')}`, {
      type: blob.type || 'video/webm',
    })
    const duration = Math.max(1, Math.round((Date.now() - audioStartRef.current) / 1000))

    try {
      const previewUrl = URL.createObjectURL(file)
      videoDraftBlobRef.current = file
      setVideoDraftSeconds(duration)
      setVideoPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current)
        return previewUrl
      })
      setVideoOverlayMode('preview')
      setVideoValidationText('Preview ready. Send or cancel.')
      setVideoValidationTone('success')
    } catch (videoSendError) {
      console.error(videoSendError)
      setError('Unable to prepare this recorded video.')
    }
  }

  async function sendRecordedVideoDraft() {
    if (!videoDraftBlobRef.current || !conversationId) return

    setSending(true)
    setError(null)
    try {
      const file = videoDraftBlobRef.current instanceof File
        ? videoDraftBlobRef.current
        : new File([videoDraftBlobRef.current], `recorded-video.${getFileExtension(videoDraftBlobRef.current, 'webm')}`, {
            type: videoDraftBlobRef.current.type || 'video/webm',
          })
      const mediaUrl = await uploadMediaToStorage(file, 'video')
      if (!mediaUrl) throw new Error('upload failed')

      const message = (await sendMessage(
        conversationId,
        'contact',
        'video',
        '[Recorded video]',
        mediaUrl,
        videoDraftSeconds
      )) as Message
      setMessages((current) => [...current, message])
      closeVideoOverlay()
      await sendAvatarReply('a recorded video', { isVideo: true })
    } catch (videoSendError) {
      console.error(videoSendError)
      setError('Unable to send this recorded video.')
    } finally {
      setSending(false)
    }
  }

  async function readVideoMetadata(file: File) {
    return new Promise<{ width: number; height: number; duration: number }>((resolve) => {
      const video = document.createElement('video')
      const objectUrl = URL.createObjectURL(file)
      video.preload = 'metadata'
      video.onloadedmetadata = () => {
        resolve({
          width: video.videoWidth,
          height: video.videoHeight,
          duration: video.duration || 0,
        })
        URL.revokeObjectURL(objectUrl)
      }
      video.onerror = () => {
        resolve({ width: 0, height: 0, duration: 0 })
        URL.revokeObjectURL(objectUrl)
      }
      video.src = objectUrl
    })
  }

  async function correctVideoOrientation(file: File) {
    const metadata = await readVideoMetadata(file)
    const forceRotation =
      metadata.width > metadata.height ||
      file.type === 'video/quicktime' ||
      /\.mov$/i.test(file.name)

    if (!forceRotation) return file

    const source = document.createElement('video')
    const sourceUrl = URL.createObjectURL(file)
    source.src = sourceUrl
    source.muted = true
    source.playsInline = true
    source.preload = 'auto'

    await new Promise<void>((resolve, reject) => {
      source.onloadedmetadata = () => resolve()
      source.onerror = () => reject(new Error('metadata failed'))
    })

    const canvas = document.createElement('canvas')
    canvas.width = source.videoHeight || metadata.height || 720
    canvas.height = source.videoWidth || metadata.width || 1280
    const context = canvas.getContext('2d')
    if (!context) {
      URL.revokeObjectURL(sourceUrl)
      return file
    }

    const canvasStream = canvas.captureStream(30)
    const sourceStream =
      (source as HTMLVideoElement & {
        captureStream?: () => MediaStream
        mozCaptureStream?: () => MediaStream
      }).captureStream?.() ||
      (source as HTMLVideoElement & { mozCaptureStream?: () => MediaStream }).mozCaptureStream?.()
    const audioTracks = sourceStream?.getAudioTracks() || []
    audioTracks.forEach((track) => canvasStream.addTrack(track))
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
      ? 'video/webm;codecs=vp8,opus'
      : 'video/webm'
    const recorder = new MediaRecorder(canvasStream, { mimeType })
    const chunks: Blob[] = []

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }

    const recording = new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }))
    })

    const drawFrame = () => {
      if (source.paused || source.ended) return
      context.save()
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.translate(canvas.width / 2, canvas.height / 2)
      context.rotate(Math.PI / 2)
      context.drawImage(source, -canvas.height / 2, -canvas.width / 2, canvas.height, canvas.width)
      context.restore()
      requestAnimationFrame(drawFrame)
    }

    recorder.start(250)
    await source.play()
    drawFrame()
    await new Promise<void>((resolve) => {
      source.onended = () => resolve()
    })
    recorder.stop()

    const correctedBlob = await recording
    URL.revokeObjectURL(sourceUrl)
    return new File([correctedBlob], file.name.replace(/\.\w+$/, '.webm'), {
      type: correctedBlob.type || 'video/webm',
    })
  }

  function setVideoValidation(text: string, tone: ValidationTone, blockRecording: boolean) {
    const now = Date.now()
    if (!blockRecording && now < videoValidationLockRef.current && text !== lastVideoValidationRef.current) {
      return
    }
    if (text !== lastVideoValidationRef.current && tone && navigator.vibrate) {
      navigator.vibrate(blockRecording ? [80, 50, 80] : 60)
    }
    if (text !== lastVideoValidationRef.current) {
      videoValidationLockRef.current = now + 1800
    }
    lastVideoValidationRef.current = text
    setVideoValidationText(text)
    setVideoValidationTone(tone)
    setVideoCanRecord(!blockRecording)
  }

  function runFaceValidation() {
    const video = videoPreviewRef.current
    if (!video || !videoStreamRef.current || videoOverlayMode !== 'live') return
    if (!video.videoWidth || !video.videoHeight) return

    if (!faceCanvasRef.current) {
      faceCanvasRef.current = document.createElement('canvas')
    }

    const canvas = faceCanvasRef.current
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return

    const width = 160
    const height = 160
    canvas.width = width
    canvas.height = height
    context.drawImage(video, 0, 0, width, height)

    const { data } = context.getImageData(0, 0, width, height)
    const centerX = width / 2
    const centerY = height / 2
    const radius = width * 0.35
    let skinPixels = 0
    let totalPixels = 0
    let brightnessSum = 0
    let skinXSum = 0
    let skinYSum = 0
    let leftSkinPixels = 0
    let rightSkinPixels = 0

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4
        const red = data[index]
        const green = data[index + 1]
        const blue = data[index + 2]
        const brightness = (red + green + blue) / 3
        const dx = x - centerX
        const dy = y - centerY

        if (dx * dx + dy * dy <= radius * radius) {
          brightnessSum += brightness
          totalPixels += 1
        }

        if (
          red > 60 &&
          green > 40 &&
          blue > 20 &&
          red > green &&
          red > blue &&
          Math.abs(red - green) > 10 &&
          brightness > 50 &&
          brightness < 240
        ) {
          skinPixels += 1
          skinXSum += x
          skinYSum += y
          if (x < centerX) leftSkinPixels += 1
          else rightSkinPixels += 1
        }
      }
    }

    const totalFramePixels = width * height
    const skinRatio = skinPixels / totalFramePixels
    const averageBrightness = totalPixels > 0 ? brightnessSum / totalPixels : 0

    if (averageBrightness < 40) {
      setVideoValidation('We need more light so the camera can see you.', 'warning', true)
      return
    }
    if (skinRatio < 0.02) {
      setVideoValidation('Position your face in the circle.', '', true)
      return
    }

    const faceCenterX = skinPixels > 0 ? skinXSum / skinPixels : centerX
    const faceCenterY = skinPixels > 0 ? skinYSum / skinPixels : centerY
    const offsetX = Math.abs(faceCenterX - centerX) / (width / 2)
    const offsetY = Math.abs(faceCenterY - centerY) / (height / 2)

    if (offsetX > 0.35 || offsetY > 0.35) {
      setVideoValidation('Center your face in the circle.', 'warning', true)
      return
    }
    if (skinRatio < 0.05) {
      setVideoValidation('Move a little closer to the camera.', 'warning', true)
      return
    }

    const totalSideSkin = leftSkinPixels + rightSkinPixels
    if (totalSideSkin > 0) {
      const asymmetry = Math.abs(leftSkinPixels - rightSkinPixels) / totalSideSkin
      if (asymmetry > 0.4) {
        setVideoValidation('Look into the camera for a clean take.', 'warning', false)
        return
      }
    }

    if (averageBrightness < 70) {
      setVideoValidation('A bit more light would help.', 'warning', false)
      return
    }

    setVideoValidation('Ready to record.', 'success', false)
  }

  async function openVideoOverlay() {
    if (videoOverlayOpen) return
    setMediaMenuOpen(false)
    setVideoOverlayOpen(true)
    setVideoOverlayMode('live')
    setVideoPermissionPending(true)
    setVideoValidationText('Preparing camera...')
    setVideoValidationTone('')
    setVideoCanRecord(false)

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } },
        audio: true,
      })
      videoStreamRef.current = stream
      const video = videoPreviewRef.current
      if (video) {
        video.srcObject = stream
        video.muted = true
        video.playsInline = true
        await video.play().catch(() => undefined)
      }
      setVideoPermissionPending(false)
      setVideoValidationText('Position your face in the circle.')
      if (faceValidationIntervalRef.current) window.clearInterval(faceValidationIntervalRef.current)
      faceValidationIntervalRef.current = window.setInterval(runFaceValidation, 500)
    } catch (videoError) {
      console.error(videoError)
      setVideoPermissionPending(false)
      setVideoValidationText('Camera access is required to record video.')
      setVideoValidationTone('error')
      setVideoCanRecord(false)
    }
  }

  function closeVideoOverlay() {
    if (recordTimerRef.current) {
      window.clearInterval(recordTimerRef.current)
      recordTimerRef.current = null
    }
    if (faceValidationIntervalRef.current) {
      window.clearInterval(faceValidationIntervalRef.current)
      faceValidationIntervalRef.current = null
    }
    if (videoRecorderRef.current && videoRecorderRef.current.state !== 'inactive') {
      videoRecorderRef.current.onstop = null
      videoRecorderRef.current.stop()
    }
    videoStreamRef.current?.getTracks().forEach((track) => track.stop())
    videoStreamRef.current = null
    videoRecorderRef.current = null
    videoChunksRef.current = []
    videoDraftBlobRef.current = null
    setRecordingMode('idle')
    setCaptureKind('none')
    setRecordingSeconds(0)
    setVideoOverlayOpen(false)
    setVideoOverlayMode('live')
    setVideoPermissionPending(false)
    setVideoValidationText('Position your face in the circle.')
    setVideoValidationTone('')
    setVideoCanRecord(false)
    setVideoPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current)
      return null
    })
    const video = videoPreviewRef.current
    if (video) {
      video.pause()
      video.srcObject = null
      video.src = ''
    }
  }

  async function openVoiceOverlay() {
    setMediaMenuOpen(false)
    setVoiceOverlayOpen(true)
    setVoiceDraftReady(false)
    setVoiceDraftTranscript('')
    setVoiceDraftSeconds(0)
    setVoiceDraftUrl((current) => {
      if (current) URL.revokeObjectURL(current)
      return null
    })
    voiceDraftBlobRef.current = null
    await startVoiceRecording()
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
        const mediaUrl = await uploadMediaToStorage(file, 'image')
        if (!mediaUrl) throw new Error('upload failed')
        const message = await sendMessage(conversationId, 'contact', 'image', caption || '[Image]', mediaUrl)
        setMessages((current) => [...current, message as Message])
        const replyPayload = await getAvatarReply(caption || 'The user shared this image.', {
          useVoice: true,
          imageUrl: mediaUrl,
          isImage: true,
        })
        const hasAudio = !!replyPayload.mediaUrl
        const reply = await sendMessage(
          conversationId,
          'avatar',
          hasAudio ? 'voice' : 'text',
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
        return
      }

      const rotatedFile = await correctVideoOrientation(file)
      const metadata = await readVideoMetadata(rotatedFile)
      const mediaUrl = await uploadMediaToStorage(rotatedFile, 'video')
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
      await sendAvatarReply(caption || 'an uploaded video', { isVideo: true })
    } catch (draftError) {
      console.error(draftError)
      setError(`Unable to send this ${kind}.`)
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

  function closeVoiceOverlay() {
    if (recordingMode !== 'idle' && captureKind === 'voice') {
      void finishVoiceRecording('cancel')
    }
    voiceDraftBlobRef.current = null
    setVoiceOverlayOpen(false)
    setVoiceDraftReady(false)
    setVoiceDraftTranscript('')
    setVoiceDraftSeconds(0)
    setVoiceDraftUrl((current) => {
      if (current) URL.revokeObjectURL(current)
      return null
    })
  }

  async function stopVoiceIntoDraft() {
    await finishVoiceRecording('draft')
  }

  async function sendVoiceDraft() {
    if (!voiceDraftBlobRef.current) return
    const blob = voiceDraftBlobRef.current
    const transcript = voiceDraftTranscript
    const duration = voiceDraftSeconds
    closeVoiceOverlay()
    await sendVoiceMessage(blob, transcript, duration)
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
    <div className="relative flex h-[100svh] min-h-[100svh] flex-col overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(72,216,255,0.2),_transparent_28%),radial-gradient(circle_at_80%_20%,_rgba(0,255,170,0.16),_transparent_22%),linear-gradient(180deg,_#061018_0%,_#07111f_48%,_#050b15_100%)] text-white">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(126,255,234,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(126,255,234,0.04)_1px,transparent_1px)] bg-[size:34px_34px] opacity-[0.16]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-44 bg-[radial-gradient(circle_at_top,_rgba(83,208,255,0.32),_transparent_58%)] blur-3xl" />
      <div className={`relative z-10 flex min-h-0 flex-1 flex-col ${isDesktopLayout ? 'mx-auto my-5 w-[min(1400px,calc(100vw-48px))] rounded-[32px] border border-white/10 bg-[#07121ccc] shadow-[0_30px_120px_rgba(0,0,0,0.42)] backdrop-blur-2xl' : ''}`}>
      <header className="relative z-10 flex items-center gap-3 border-b border-white/8 bg-[#0d1826]/72 px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.24)] backdrop-blur-2xl">
        {owner.avatar_url ? (
          <img src={owner.avatar_url} alt={owner.display_name} className="h-10 w-10 rounded-full object-cover" />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-[#4bd8ff] via-[#17c8a4] to-[#067b72] text-sm font-bold text-white shadow-[0_0_24px_rgba(38,218,200,0.35)]">
            {owner.display_name.split(/\s+/).map(w => w.charAt(0).toUpperCase()).join('').slice(0, 2)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-white">{owner.display_name}</h1>
          <p className="text-xs text-[#84f5e1]">{avatarTyping ? 'typing...' : 'online'}</p>
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
      </header>

      <main
        className="relative z-0 min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 pb-6"
      >
        <div className={`mx-auto flex w-full flex-col gap-3 ${isDesktopLayout ? 'max-w-[920px] py-6' : 'max-w-2xl'}`}>
          {groupedTimeline.map((item) => {
            if (item.kind === 'date') {
              return (
                <div key={item.key} className="my-2 flex justify-center">
                  <span className="rounded-full border border-white/10 bg-[#0f1d2d]/84 px-3 py-1 text-xs text-white/70 shadow-[0_8px_32px_rgba(0,0,0,0.22)] backdrop-blur-xl">
                    {item.label}
                  </span>
                </div>
              )
            }

            const message = item.message
            const isContact = message.sender === 'contact'

            return (
              <div key={message.id} className={`flex ${isContact ? 'justify-end' : 'justify-start'}`}>
                {message.type === 'voice' ? (
                  <VoiceMessageBubble
                    isContact={isContact}
                    message={message}
                    transcript={transcriptMap[message.id] || (!isPlaceholderContent(message) ? message.content || '' : '')}
                  />
                ) : message.type === 'image' || message.type === 'video' ? (
                  <MediaMessageBubble isContact={isContact} message={message} />
                ) : (
                  <div
                    className={`relative max-w-[84%] rounded-[24px] border px-3 py-2.5 text-sm shadow-[0_18px_50px_rgba(0,0,0,0.18)] backdrop-blur-xl ${
                      isContact
                        ? 'rounded-tr-md border-[#47dfc2]/20 bg-[linear-gradient(180deg,rgba(8,118,100,0.9),rgba(5,86,79,0.92))] text-white'
                        : 'rounded-tl-md border-white/8 bg-[linear-gradient(180deg,rgba(22,34,51,0.86),rgba(12,24,39,0.92))] text-white'
                    }`}
                  >
                    <span>{message.content}</span>
                    <span className="mt-1 block text-right text-[10px] text-white/45">
                      {formatMessageTime(message.created_at)}
                    </span>
                  </div>
                )}
              </div>
            )
          })}

          {avatarTyping ? (
            <div className="flex justify-start">
              <div className="rounded-[24px] rounded-tl-md border border-white/8 bg-[linear-gradient(180deg,rgba(22,34,51,0.86),rgba(12,24,39,0.92))] px-4 py-3 shadow-[0_18px_50px_rgba(0,0,0,0.18)] backdrop-blur-xl">
                <div className="flex gap-1">
                  <span className="h-2 w-2 animate-bounce rounded-full bg-white/40" style={{ animationDelay: '0ms' }} />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-white/40" style={{ animationDelay: '150ms' }} />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-white/40" style={{ animationDelay: '300ms' }} />
                </div>
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

      <footer className="relative z-20 border-t border-white/8 bg-[#101b28]/82 px-3 pt-2 backdrop-blur-2xl">
        <div className={`mx-auto flex items-end gap-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] ${isDesktopLayout ? 'max-w-[980px]' : 'max-w-2xl'}`}>
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setMediaMenuOpen((current) => !current)}
              disabled={sending || recordingMode !== 'idle'}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/10 bg-[linear-gradient(180deg,rgba(27,43,63,0.94),rgba(16,27,40,0.94))] text-[#9af8ea] shadow-[0_0_28px_rgba(92,221,212,0.18)] transition hover:border-[#74f0df]/40 hover:text-white disabled:opacity-40"
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
                  onClick={() => {
                    setMediaMenuOpen(false)
                    void openVideoOverlay()
                  }}
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
              className="w-full rounded-full border border-white/10 bg-[linear-gradient(180deg,rgba(26,42,61,0.92),rgba(18,31,47,0.96))] px-4 py-3 text-base text-white placeholder-white/30 outline-none focus:border-[#79f5df]/45 focus:ring-2 focus:ring-[#79f5df]/18 disabled:opacity-40"
              style={{ fontSize: '16px' }}
            />
          </div>

          <button
            type="button"
            onClick={() => void openVoiceOverlay()}
            disabled={sending || text.trim().length > 0 || videoOverlayOpen || mediaMenuOpen}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#10c8a6] to-[#0f9f88] text-white shadow-[0_0_32px_rgba(16,200,166,0.28)] transition hover:brightness-110 disabled:opacity-40"
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
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#0c886d] to-[#0d6d72] text-white shadow-[0_0_32px_rgba(32,201,177,0.18)] transition hover:brightness-110 disabled:opacity-40"
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

      {liveCallOpen ? (
        <div className="absolute inset-0 z-30 bg-[radial-gradient(circle_at_top,rgba(57,188,255,0.16),transparent_30%),linear-gradient(180deg,rgba(2,8,16,0.96),rgba(2,6,12,0.98))]">
          <div className="flex h-full flex-col px-4 pb-[calc(env(safe-area-inset-bottom)+20px)] pt-[calc(env(safe-area-inset-top)+20px)]">
            <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-[0.32em] text-[#86f7e4]/70">Live Call</div>
                <h2 className="mt-2 text-xl font-semibold text-white">{owner.display_name}</h2>
                <p className="mt-1 text-sm text-white/60">
                  {liveCallState === 'starting'
                    ? 'Preparing avatar'
                    : liveCallState === 'joining'
                      ? 'Joining room'
                      : liveCallState === 'connected'
                        ? 'Connected'
                        : 'Waiting'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void closeLiveCall()}
                className="rounded-full bg-[linear-gradient(180deg,rgba(255,103,131,0.94),rgba(216,54,92,0.94))] px-5 py-3 text-sm font-semibold text-white shadow-[0_0_36px_rgba(255,88,116,0.22)]"
              >
                Hang up
              </button>
            </div>

            {liveCallError ? (
              <div className="mx-auto mt-4 w-full max-w-6xl rounded-3xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                {liveCallError}
              </div>
            ) : null}

            <div
              className={`mx-auto mt-6 grid w-full max-w-6xl flex-1 gap-4 ${
                isDesktopLayout ? 'grid-cols-[minmax(0,1.5fr)_minmax(300px,0.72fr)]' : 'grid-rows-[minmax(0,1fr)_minmax(180px,0.55fr)]'
              }`}
            >
              <section className="relative overflow-hidden rounded-[32px] border border-white/10 bg-[linear-gradient(180deg,rgba(10,20,33,0.96),rgba(5,10,18,0.98))] shadow-[0_28px_110px_rgba(0,0,0,0.4)]">
                <video ref={liveRemoteVideoRef} className="h-full w-full object-cover" autoPlay playsInline />
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(90,214,255,0.12),transparent_34%)]" />
                {!liveRemoteParticipant ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[linear-gradient(180deg,rgba(4,9,17,0.72),rgba(4,9,17,0.82))] text-center text-white/70">
                    <div className="flex h-20 w-20 items-center justify-center rounded-full border border-white/10 bg-white/5">
                      <svg className="h-8 w-8" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M17 10.5V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-3.5l4 4v-11l-4 4z" />
                      </svg>
                    </div>
                    <div className="text-base font-medium text-white">{owner.display_name}</div>
                    <div className="text-sm text-white/55">Waiting for avatar video…</div>
                  </div>
                ) : null}
                <div className="absolute bottom-4 left-4 rounded-full bg-black/35 px-4 py-2 text-sm text-white/88 backdrop-blur-xl">
                  {getParticipantName(liveRemoteParticipant, owner.display_name)}
                </div>
              </section>

              <section className="relative overflow-hidden rounded-[32px] border border-white/10 bg-[linear-gradient(180deg,rgba(14,28,44,0.96),rgba(8,16,27,0.98))] shadow-[0_28px_110px_rgba(0,0,0,0.34)]">
                <video ref={liveLocalVideoRef} className="h-full w-full object-cover [-webkit-transform:scaleX(-1)] [transform:scaleX(-1)]" autoPlay playsInline muted />
                {!liveLocalParticipant?.tracks?.video?.persistentTrack ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[linear-gradient(180deg,rgba(7,14,23,0.76),rgba(7,14,23,0.9))] text-center text-white/68">
                    <div className="flex h-16 w-16 items-center justify-center rounded-full border border-white/10 bg-white/5">
                      <svg className="h-7 w-7" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M17 10.5V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-3.5l4 4v-11l-4 4z" />
                      </svg>
                    </div>
                    <div className="text-sm text-white/55">Camera preview will appear here.</div>
                  </div>
                ) : null}
                <div className="absolute bottom-4 left-4 rounded-full bg-black/35 px-4 py-2 text-sm text-white/88 backdrop-blur-xl">
                  {getParticipantName(liveLocalParticipant, conversation.wa_contacts.display_name || 'You')}
                </div>
                {liveCallRoomUrl ? (
                  <div className="absolute right-4 top-4 rounded-full border border-white/10 bg-black/28 px-3 py-1.5 text-[11px] uppercase tracking-[0.22em] text-white/55 backdrop-blur-xl">
                    Daily WebRTC
                  </div>
                ) : null}
              </section>
            </div>
          </div>
        </div>
      ) : null}

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
    </div>
  )
}
