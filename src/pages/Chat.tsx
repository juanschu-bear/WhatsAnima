import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useParams } from 'react-router-dom'
import { createPerceptionLog, getConversation, listMessages, listPerceptionLogs, sendMessage } from '../lib/api'
import { supabase } from '../lib/supabase'

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

const AUDIO_BUCKETS = ['voice-messages']
const IMAGE_BUCKETS = ['image-uploads', 'voice-messages']
const VIDEO_BUCKETS = ['video-uploads', 'voice-messages']
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

function isRecordedVideoMessage(message: Message) {
  return (message.content || '') === '[Recorded video]'
}

function isPlaceholderContent(message: Message) {
  return ['[Image]', '[Video]', '[Recorded video]', '[Voice message]', 'Voice note'].includes(
    message.content || ''
  )
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
  const videoInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)

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
    return () => {
      if (recordTimerRef.current) window.clearInterval(recordTimerRef.current)
      audioStreamRef.current?.getTracks().forEach((track) => track.stop())
      videoStreamRef.current?.getTracks().forEach((track) => track.stop())
      speechRecognitionRef.current?.stop?.()
    }
  }, [])

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

  async function uploadToStorage(file: File | Blob, kind: 'audio' | 'image' | 'video') {
    if (!conversation) return null

    const buckets = kind === 'audio' ? AUDIO_BUCKETS : kind === 'image' ? IMAGE_BUCKETS : VIDEO_BUCKETS
    const extension = getFileExtension(file, kind === 'image' ? 'jpg' : kind === 'video' ? 'mp4' : 'webm')
    const path = `${conversation.owner_id}/${conversation.id}/${Date.now()}-${crypto.randomUUID()}.${extension}`

    for (const bucket of buckets) {
      const uploadPath = bucket === 'voice-messages' && kind === 'image' ? `images/${path}` : path
      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(uploadPath, file, { contentType: file.type || undefined, upsert: false })

      if (uploadError) continue

      const { data } = supabase.storage.from(bucket).getPublicUrl(uploadPath)
      return data.publicUrl
    }

    return null
  }

  async function getAvatarReply(
    userMessage: string,
    voiceId: string | null | undefined
  ): Promise<{ content: string; mediaUrl: string | null }> {
    if (!voiceId) {
      return {
        content: 'Voice service is not configured for this owner.',
        mediaUrl: null,
      }
    }

    try {
      const replyText = `You said: "${userMessage}". Thank you for your message! I'm here to chat with you.`
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: replyText,
          voiceId,
        }),
      })

      if (!response.ok) {
        return {
          content: 'Sorry, I could not generate a voice response right now.',
          mediaUrl: null,
        }
      }

      const audioBlob = await response.blob()
      const uploadedUrl = await uploadToStorage(
        new File([audioBlob], `avatar-reply.${getFileExtension(audioBlob, 'mp3')}`, { type: audioBlob.type || 'audio/mpeg' }),
        'audio'
      )

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

  async function sendAvatarReply(seedText: string) {
    if (!conversationId) return
    setAvatarTyping(true)
    try {
      const replyPayload = await getAvatarReply(seedText, conversation?.wa_owners.voice_id)
      const reply = await sendMessage(
        conversationId,
        'avatar',
        'voice',
        replyPayload.content,
        replyPayload.mediaUrl ?? undefined
      )
      setMessages((current) => [...current, reply as Message])
      setTranscriptMap((current) => ({
        ...current,
        [String((reply as Message).id)]: String(replyPayload.content),
      }))
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
      await sendAvatarReply(content)
    } catch (sendError) {
      console.error(sendError)
      setError('Unable to send your message.')
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

  async function finishVoiceRecording(send = true) {
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

    if (!send || !blob || !conversationId || !conversation) return

    const durationSeconds = Math.max(1, Math.round((Date.now() - audioStartRef.current) / 1000))
    const file = new File([blob], `voice-note.${getFileExtension(blob, 'webm')}`, { type: blob.type || 'audio/webm' })

    setSending(true)
    setError(null)
    try {
      const mediaUrl = await uploadToStorage(file, 'audio')
      if (!mediaUrl) throw new Error('upload failed')

      const transcript = browserTranscriptRef.current.trim()
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

      await sendAvatarReply(transcript || 'a voice message')
    } catch (recordingError) {
      console.error(recordingError)
      setError('Unable to send this voice note.')
    } finally {
      browserTranscriptRef.current = ''
      setSending(false)
    }
  }

  async function startLiveVideoRecording() {
    if (!conversation) return

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true })
      const mimeTypeOptions = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
      const mimeType = mimeTypeOptions.find((option) => MediaRecorder.isTypeSupported(option)) || ''
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      videoStreamRef.current = stream
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

    setSending(true)
    setError(null)
    try {
      const mediaUrl = await uploadToStorage(file, 'video')
      if (!mediaUrl) throw new Error('upload failed')

      const message = (await sendMessage(
        conversationId,
        'contact',
        'video',
        '[Recorded video]',
        mediaUrl,
        duration
      )) as Message
      setMessages((current) => [...current, message])
      await sendAvatarReply('a recorded video')
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
        const mediaUrl = await uploadToStorage(file, 'image')
        if (!mediaUrl) throw new Error('upload failed')
        const message = await sendMessage(conversationId, 'contact', 'image', caption || '[Image]', mediaUrl)
        setMessages((current) => [...current, message as Message])
        await sendAvatarReply(caption || 'an image')
        return
      }

      const rotatedFile = await correctVideoOrientation(file)
      const metadata = await readVideoMetadata(rotatedFile)
      const mediaUrl = await uploadToStorage(rotatedFile, 'video')
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
      await sendAvatarReply(caption || 'an uploaded video')
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

  async function handleVoicePointerDown() {
    if (sending || recordingMode !== 'idle') return
    await startVoiceRecording()
  }

  async function handleVoicePointerUp() {
    if (recordingMode === 'recording') {
      await finishVoiceRecording(true)
    }
  }

  async function handleVoicePointerCancel() {
    if (recordingMode === 'recording') {
      await finishVoiceRecording(false)
    }
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

      <header className="relative z-10 flex items-center gap-3 border-b border-white/8 bg-[#0d1826]/72 px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.24)] backdrop-blur-2xl">
        {owner.avatar_url ? (
          <img src={owner.avatar_url} alt={owner.display_name} className="h-10 w-10 rounded-full object-cover" />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-[#4bd8ff] via-[#17c8a4] to-[#067b72] text-sm font-bold text-white shadow-[0_0_24px_rgba(38,218,200,0.35)]">
            {owner.display_name.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-white">{owner.display_name}</h1>
          <p className="text-xs text-[#84f5e1]">{avatarTyping ? 'typing...' : 'online'}</p>
        </div>
      </header>

      <main
        className="relative z-0 min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 pb-6"
      >
        <div className="mx-auto flex max-w-2xl flex-col gap-3">
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
              onClick={() => finishVoiceRecording(false)}
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
        <div className="mx-auto flex max-w-2xl items-end gap-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
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
                    void (videoRecorderRef.current ? stopLiveVideoRecording() : startLiveVideoRecording())
                  }}
                  className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm text-white/88 transition hover:bg-white/6"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#173447] text-[#88ffe4]">
                    <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M17 10.5V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-3.5l4 4v-11l-4 4z" />
                    </svg>
                  </span>
                  <span>{videoRecorderRef.current ? 'Stop recording' : 'Record video'}</span>
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
            onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => {
              event.preventDefault()
              void handleVoicePointerDown()
            }}
            onPointerUp={(event: ReactPointerEvent<HTMLButtonElement>) => {
              event.preventDefault()
              void handleVoicePointerUp()
            }}
            onPointerCancel={() => void handleVoicePointerCancel()}
            onPointerLeave={() => void handleVoicePointerCancel()}
            disabled={sending || text.trim().length > 0 || videoRecorderRef.current !== null || mediaMenuOpen}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#10c8a6] to-[#0f9f88] text-white shadow-[0_0_32px_rgba(16,200,166,0.28)] transition hover:brightness-110 disabled:opacity-40"
            title="Hold to record voice note"
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
