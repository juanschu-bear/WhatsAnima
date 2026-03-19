import { useRef, useState } from 'react'
import { createPerceptionLog, sendMessage } from '../lib/api'
import {
  getFileExtension,
  uploadAudioToStorage,
  callOpmApi, transcribeServerSide,
} from '../lib/mediaUtils'

type RecordingMode = 'idle' | 'recording' | 'stopping'
type CaptureKind = 'none' | 'voice' | 'video'
const VOICE_MAX_SECONDS = 300

interface Message {
  id: string
  sender: 'contact' | 'avatar'
  type: 'text' | 'voice' | 'video' | 'image'
  content: string | null
  media_url: string | null
  duration_sec: number | null
  created_at: string
  _pending?: boolean
  _failed?: boolean
  _errorMessage?: string
  _localBlobUrl?: string
  _retryFn?: () => void
}

interface ConversationRef {
  id: string
  owner_id: string
  contact_id: string
  wa_contacts?: { display_name?: string | null } | null
}

interface UseVoiceRecordingOptions {
  conversationId: string | undefined
  conversation: ConversationRef | null
  onSending: (sending: boolean) => void
  onError: (error: string | null) => void
  onMessageSent: (message: Message) => void
  onMessageUpdate: (tempId: string, updates: Partial<Message>) => void
  onTranscript: (messageId: string, transcript: string) => void
  sendAvatarReply: (text: string, options?: { isVoice?: boolean; voiceDurationSec?: number; perception?: any; userMessageId?: string }) => Promise<boolean>
  simulateAvatarRead: (messageId: string) => void
  maybeAvatarReact: (messageId: string) => void
}

export function useVoiceRecording({
  conversationId,
  conversation,
  onSending,
  onError,
  onMessageSent,
  onMessageUpdate,
  onTranscript,
  sendAvatarReply,
  simulateAvatarRead,
  maybeAvatarReact,
}: UseVoiceRecordingOptions) {
  // Shared recording state (also used by video capture)
  const [recordingMode, setRecordingMode] = useState<RecordingMode>('idle')
  const [captureKind, setCaptureKind] = useState<CaptureKind>('none')
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const recordTimerRef = useRef<number | null>(null)
  const speechRecognitionRef = useRef<{ stop(): void } | null>(null)
  const browserTranscriptRef = useRef('')
  const audioStartRef = useRef(0)

  // Voice-specific state
  const [voiceOverlayOpen, setVoiceOverlayOpen] = useState(false)
  const [voiceDraftUrl, setVoiceDraftUrl] = useState<string | null>(null)
  const [voiceDraftReady, setVoiceDraftReady] = useState(false)
  const [voiceDraftSeconds, setVoiceDraftSeconds] = useState(0)
  const [voiceDraftTranscript, setVoiceDraftTranscript] = useState('')

  // Voice-specific refs
  const audioRecorderRef = useRef<MediaRecorder | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const audioStopResolverRef = useRef<((blob: Blob | null) => void) | null>(null)
  const voiceDraftBlobRef = useRef<Blob | null>(null)

  function stopRecordingTimer() {
    if (recordTimerRef.current) {
      window.clearInterval(recordTimerRef.current)
      recordTimerRef.current = null
    }
  }

  function startSpeechRecognition() {
    // Browser SpeechRecognition is single-language only — it produces garbage
    // when the user speaks a different language than the app locale (e.g. Spanish
    // while locale is German). Since our users are multilingual (DE/EN/ES), we
    // skip browser STT entirely and rely on Deepgram Nova-3 server-side
    // transcription which supports multi-language code-switching natively.
    // The browser transcript was only used as a last-resort fallback anyway
    // (line 149-152 in sendVoiceMessage: server → OPM → browser → fallback).
    browserTranscriptRef.current = ''
    speechRecognitionRef.current = null
  }

  async function sendVoiceMessage(blob: Blob, browserTranscript: string, durationSeconds: number) {
    if (!conversationId || !conversation) return

    const file = new File([blob], `voice-note.${getFileExtension(blob, 'webm')}`, {
      type: blob.type || 'audio/webm',
    })

    // Show message immediately in chat with local blob URL
    const tempId = `temp-voice-${Date.now()}`
    const localBlobUrl = URL.createObjectURL(blob)
    const optimisticMessage: Message = {
      id: tempId,
      sender: 'contact',
      type: 'voice',
      content: null,
      media_url: localBlobUrl,
      duration_sec: durationSeconds,
      created_at: new Date().toISOString(),
      _pending: true,
      _localBlobUrl: localBlobUrl,
    }
    onMessageSent(optimisticMessage)
    onSending(true)
    onError(null)

    const doSend = async () => {
      // Show pending state (important for retry — first call already has _pending from optimisticMessage)
      onMessageUpdate(tempId, { _pending: true, _failed: false, _errorMessage: undefined, _retryFn: undefined })
      onSending(true)
      try {
        const contentType = file.type || 'audio/webm'

        const [mediaUrl, serverTranscript, opmResponse] = await Promise.all([
          uploadAudioToStorage(conversation, file, contentType),
          transcribeServerSide(file, contentType),
          callOpmApi(conversation, file, 'audio').catch((error) => {
            console.error('[Voice] OPM voice analysis failed:', error)
            return null
          }),
        ])
        if (!mediaUrl) throw new Error('upload failed')

        if (!opmResponse) {
          throw new Error('Voice perception processing failed. Please resend.')
        }

        const finalTranscript = (
          serverTranscript
          || opmResponse?.transcript?.trim()
          || browserTranscript
          || ''
        ).trim()

        if (!finalTranscript) {
          throw new Error('Voice transcription failed. Please resend.')
        }

        console.log('[sendVoiceMessage] transcript sources:', {
          server: serverTranscript?.slice(0, 60) || '(empty)',
          opm: opmResponse?.transcript?.slice(0, 60) || '(empty)',
          browser: browserTranscript?.slice(0, 60) || '(empty)',
          final: finalTranscript.slice(0, 60),
        })

        const message = (await sendMessage(
          conversationId,
          'contact',
          'voice',
          finalTranscript,
          mediaUrl,
          durationSeconds
        )) as Message

        // Replace optimistic message with real one, keep local blob URL as fallback
        onMessageUpdate(tempId, {
          id: message.id,
          content: finalTranscript,
          media_url: mediaUrl,
          _pending: false,
          _failed: false,
          _localBlobUrl: localBlobUrl,
        })
        simulateAvatarRead(message.id)

        createPerceptionLog({
          messageId: message.id,
          conversationId: conversation.id,
          contactId: conversation.contact_id,
          ownerId: conversation.owner_id,
          transcript: finalTranscript,
          audioDurationSec: durationSeconds,
          primaryEmotion: opmResponse?.perception?.primary_emotion ?? null,
          secondaryEmotion: opmResponse?.perception?.secondary_emotion ?? null,
          firedRules: opmResponse?.fired_rules ?? null,
          behavioralSummary: opmResponse?.behavioral_summary ?? opmResponse?.perception?.behavioral_summary ?? opmResponse?.interpretation?.behavioral_summary ?? null,
          conversationHooks: opmResponse?.conversation_hooks ?? opmResponse?.interpretation?.conversation_hooks ?? null,
          recommendedTone: opmResponse?.recommended_tone ?? opmResponse?.perception?.recommended_tone ?? opmResponse?.interpretation?.recommended_tone ?? null,
          prosodicSummary: opmResponse?.prosodic_summary ?? null,
          mediaType: 'audio',
        }).catch((logErr) => console.warn('[perception-log]', logErr.message))
        onTranscript(message.id, finalTranscript)

        const voiceReplied = await sendAvatarReply(finalTranscript, {
          isVoice: true,
          voiceDurationSec: durationSeconds,
          perception: opmResponse,
          userMessageId: message.id,
        })
        if (voiceReplied) maybeAvatarReact(message.id)
      } catch (recordingError: any) {
        console.error('[sendVoiceMessage]', recordingError)
        // Mark message as failed but keep it in chat with retry
        onMessageUpdate(tempId, {
          _pending: false,
          _failed: true,
          _errorMessage: recordingError?.message || 'Unable to send this voice note.',
          _retryFn: () => {
            // Reset visual state before retrying
            onMessageUpdate(tempId, { _pending: true, _failed: false, _errorMessage: undefined, _retryFn: undefined })
            doSend()
          },
        })
      } finally {
        onSending(false)
      }
    }

    await doSend()
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
        if (elapsed >= VOICE_MAX_SECONDS) {
          void finishVoiceRecording('draft')
        }
      }, 250)
    } catch (startError) {
      console.error(startError)
      setRecordingMode('idle')
      onError('Microphone access is required to record voice notes.')
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
    if (durationSeconds > VOICE_MAX_SECONDS) {
      onError('Voice notes are limited to 5 minutes.')
      return
    }
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

  async function openVoiceOverlay() {
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

  return {
    // Shared recording state (for video capture to use)
    recordingMode,
    setRecordingMode,
    captureKind,
    setCaptureKind,
    recordingSeconds,
    setRecordingSeconds,
    recordTimerRef,
    speechRecognitionRef,
    browserTranscriptRef,
    audioStartRef,
    audioStreamRef,

    // Shared functions
    stopRecordingTimer,
    startSpeechRecognition,

    // Voice-specific state
    voiceOverlayOpen,
    voiceDraftUrl,
    voiceDraftReady,
    voiceDraftSeconds,
    voiceDraftTranscript,

    // Voice-specific functions
    openVoiceOverlay,
    closeVoiceOverlay,
    stopVoiceIntoDraft,
    sendVoiceDraft,
    finishVoiceRecording,
  }
}
