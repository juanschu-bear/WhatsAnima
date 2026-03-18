import { useEffect, useRef, useState } from 'react'
import { createPerceptionLog, sendMessage } from '../lib/api'
import { blobToBase64, delay, getFileExtension } from '../lib/mediaUtils'

const VIDEO_CAPTURE_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: 'user',
  width: { ideal: 720 },
  height: { ideal: 720 },
}

const VIDEO_CAPTURE_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

const OPM_CLIENT_TIMEOUT_MS = 180000
const OPM_CLIENT_POLL_INTERVAL_MS = 3000

type RecordingMode = 'idle' | 'recording' | 'stopping'

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

interface StageState {
  emoji: string
  text: string
  progress: number
}

interface UseVideoRecordingOptions {
  conversationId: string | undefined
  conversation: ConversationRef | null
  onSending: (sending: boolean) => void
  onError: (error: string | null) => void
  onMessageSent: (message: Message) => void
  onMessageUpdate: (tempId: string, updates: Partial<Message>) => void
  onTranscript: (messageId: string, transcript: string) => void
  sendAvatarReply: (text: string, options?: { isVideo?: boolean; videoDurationSec?: number; perception?: any; userMessageId?: string }) => Promise<boolean>
  simulateAvatarRead: (messageId: string) => void
  maybeAvatarReact: (messageId: string) => void
}

function firstNonEmptyString(values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function normalizeOpmResponse(raw: any) {
  const unwrapped = raw?.result || raw?.data || raw || {}
  const echoAnalysis = unwrapped?.echo_analysis || null
  const standardAnalysis = unwrapped?.standard_analysis || null

  if (echoAnalysis || standardAnalysis) {
    const analysis = echoAnalysis || standardAnalysis
    const audioFeatures = analysis?.audio_features || {}
    const firedRules = analysis?.fired_rules || []
    const transcript = firstNonEmptyString([
      unwrapped?.layers?.cygnus?.audio?.transcript?.text,
      raw?.layers?.cygnus?.audio?.transcript?.text,
      audioFeatures?.transcript,
      analysis?.transcript,
      unwrapped?.transcript,
      raw?.transcript,
    ])
    const sessionObj = unwrapped?.session || null
    const lucidText =
      sessionObj?.lucid_interpretation?.interpretation
      || sessionObj?.session_interpretation?.interpretation
      || ''
    const sessionPatterns = sessionObj?.session_analysis?.session_patterns || []

    return {
      transcript,
      perception: {
        primary_emotion: audioFeatures?.primary_emotion || null,
        secondary_emotion: audioFeatures?.secondary_emotion || null,
        valence: audioFeatures?.valence ?? null,
        arousal: audioFeatures?.arousal ?? null,
        confidence: audioFeatures?.confidence ?? null,
        behavioral_summary: lucidText || null,
        recommended_tone: analysis?.recommended_tone || sessionObj?.lucid_interpretation?.recommended_tone || null,
        session_patterns: sessionPatterns,
        transcript,
      },
      interpretation: {
        behavioral_summary: lucidText || '',
        conversation_hooks: sessionPatterns.map((pattern: any) =>
          typeof pattern === 'string' ? pattern : pattern?.pattern || pattern?.description || JSON.stringify(pattern)
        ),
        recommended_tone: analysis?.recommended_tone || sessionObj?.lucid_interpretation?.recommended_tone || null,
        lucid_raw: Boolean(lucidText),
      },
      session: sessionObj,
      analysisType: echoAnalysis ? 'echo' : 'standard',
      duration_sec: analysis?.duration_sec || null,
      processing_ms: analysis?.processing_ms || null,
      skipped_reason: analysis?.skipped_reason || null,
      prosodic_summary: audioFeatures?.prosodic_summary || null,
      fired_rules: firedRules,
    }
  }

  return {
    transcript: firstNonEmptyString([
      unwrapped?.layers?.cygnus?.audio?.transcript?.text,
      raw?.layers?.cygnus?.audio?.transcript?.text,
      unwrapped?.transcript,
      raw?.transcript,
    ]),
    perception: unwrapped?.perception || {},
    interpretation: unwrapped?.interpretation || {},
    session: unwrapped?.session || null,
    analysisType: 'legacy',
    fired_rules: [],
  }
}

async function getOpmConfig() {
  const response = await fetch('/api/config')
  const data = await response.json().catch(() => ({}))
  return {
    opm_api_url: typeof data.opm_api_url === 'string' ? data.opm_api_url : null,
    opm_preset: typeof data.opm_preset === 'string' ? data.opm_preset : 'celebrity_ceo',
  }
}

export function useVideoRecording({
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
}: UseVideoRecordingOptions) {
  const [videoOverlayOpen, setVideoOverlayOpen] = useState(false)
  const [recordingMode, setRecordingMode] = useState<RecordingMode>('idle')
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewDuration, setPreviewDuration] = useState(0)
  const [processingStage, setProcessingStage] = useState<StageState | null>(null)

  const liveVideoRef = useRef<HTMLVideoElement | null>(null)
  const previewVideoRef = useRef<HTMLVideoElement | null>(null)
  const videoStreamRef = useRef<MediaStream | null>(null)
  const videoRecorderRef = useRef<MediaRecorder | null>(null)
  const videoChunksRef = useRef<Blob[]>([])
  const videoBlobRef = useRef<Blob | null>(null)
  const startTimeRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const stopResolverRef = useRef<((blob: Blob | null) => void) | null>(null)

  const isIOSSafari =
    typeof navigator !== 'undefined'
    && /iPad|iPhone|iPod/.test(navigator.userAgent)

  const isMobileDevice =
    typeof navigator !== 'undefined'
    && /iPad|iPhone|iPod|Android/i.test(navigator.userAgent)

  function stopTimer() {
    if (timerRef.current) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  function pickVideoMimeType() {
    if (typeof MediaRecorder === 'undefined') return ''
    if (isIOSSafari) {
      return MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : ''
    }
    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) return 'video/webm;codecs=vp9,opus'
    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) return 'video/webm;codecs=vp8,opus'
    if (MediaRecorder.isTypeSupported('video/webm')) return 'video/webm'
    if (MediaRecorder.isTypeSupported('video/mp4')) return 'video/mp4'
    return ''
  }

  async function startVideoPreview() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: VIDEO_CAPTURE_VIDEO_CONSTRAINTS,
      audio: VIDEO_CAPTURE_AUDIO_CONSTRAINTS,
    })

    videoStreamRef.current = stream

    const liveVideo = liveVideoRef.current
    if (liveVideo) {
      liveVideo.srcObject = stream
      liveVideo.setAttribute('muted', '')
      liveVideo.muted = true
      liveVideo.setAttribute('playsinline', '')
      liveVideo.playsInline = true
      await liveVideo.play().catch(() => undefined)
    }
  }

  function stopVideoPreview() {
    videoStreamRef.current?.getTracks().forEach((track) => track.stop())
    videoStreamRef.current = null
    if (liveVideoRef.current) {
      liveVideoRef.current.srcObject = null
    }
  }

  function correctVideoOrientation(blob: Blob, _force = false): Promise<Blob> {
    return new Promise((resolve) => {
      if (isMobileDevice) {
        resolve(blob)
        return
      }
      resolve(blob)
    })
  }

  function enterVideoPreview(blob: Blob) {
    const url = URL.createObjectURL(blob)
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current)
      return url
    })

    const previewVideo = previewVideoRef.current
    if (previewVideo) {
      previewVideo.setAttribute('playsinline', '')
      previewVideo.setAttribute('webkit-playsinline', 'true')
      previewVideo.playsInline = true
      previewVideo.src = url
      previewVideo.load()
      previewVideo.play().catch(() => undefined)
    }
  }

  async function startVideoRecording() {
    if (!videoStreamRef.current || recordingMode !== 'idle') return

    const mimeType = pickVideoMimeType()
    const recorder = mimeType
      ? new MediaRecorder(videoStreamRef.current, { mimeType })
      : new MediaRecorder(videoStreamRef.current)

    videoRecorderRef.current = recorder
    videoChunksRef.current = []
    startTimeRef.current = Date.now()
    setRecordingSeconds(0)
    setRecordingMode('recording')

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) videoChunksRef.current.push(event.data)
    }

    recorder.onstop = () => {
      const rawBlob = videoChunksRef.current.length
        ? new Blob(videoChunksRef.current, { type: recorder.mimeType || mimeType || 'video/webm' })
        : null
      videoRecorderRef.current = null
      stopResolverRef.current?.(rawBlob)
      stopResolverRef.current = null
    }

    recorder.start(100)

    timerRef.current = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000)
      setRecordingSeconds(elapsed)
    }, 250)
  }

  async function stopVideoRecording() {
    if (recordingMode !== 'recording') return

    setRecordingMode('stopping')
    stopTimer()

    const blobPromise = new Promise<Blob | null>((resolve) => {
      stopResolverRef.current = resolve
    })

    if (videoRecorderRef.current && videoRecorderRef.current.state !== 'inactive') {
      videoRecorderRef.current.stop()
    } else {
      stopResolverRef.current?.(null)
    }

    const rawBlob = await blobPromise
    const durationSeconds = Math.max(1, Math.round((Date.now() - startTimeRef.current) / 1000))
    setRecordingMode('idle')
    setRecordingSeconds(0)

    if (!rawBlob) return

    stopVideoPreview()
    const correctedBlob = await correctVideoOrientation(rawBlob).catch(() => rawBlob)
    videoBlobRef.current = correctedBlob
    setPreviewDuration(durationSeconds)
    enterVideoPreview(correctedBlob)
  }

  async function uploadVideoToStorage(targetConversation: ConversationRef, videoBlob: Blob, mimeType: string) {
    const cleanType = (mimeType || 'video/webm').split(';')[0]
    const ext = getFileExtension(
      videoBlob as Blob & { name?: string; type: string },
      cleanType === 'video/mp4' ? 'mp4' : cleanType === 'video/quicktime' ? 'mov' : 'webm'
    )
    const filename = `video-${Date.now()}.${ext}`
    const storagePath = `${targetConversation.id}/${filename}`
    const bucket = 'video-messages'

    try {
      const { supabase } = await import('../lib/supabase')
      const { data, error } = await supabase.storage
        .from(bucket)
        .upload(storagePath, videoBlob, { contentType: cleanType, upsert: true })

      if (!error) {
        const storedPath = data?.path || storagePath
        const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(storedPath)
        return urlData.publicUrl
      }
    } catch {
      // Continue to API fallback below.
    }

    const base64Media = await blobToBase64(videoBlob)
    const res = await fetch('/api/upload-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media: base64Media,
        conversationId: targetConversation.id,
        owner_id: targetConversation.owner_id,
        mime_type: cleanType,
        media_type: 'video',
        bucket,
      }),
    })

    const data = await res.json().catch(() => ({}))
    if (res.ok && data.url) return data.url as string
    throw new Error('Upload failed: ' + (data.error || `HTTP ${res.status}`))
  }

  async function callOpmApi(
    mediaBlob: Blob,
    onStage: (emoji: string, text: string, progress: number) => void,
    mediaType: 'audio' | 'video' = 'video',
    opts: { orientation?: number } = {}
  ) {
    if (!conversation) throw new Error('Missing conversation')

    const config = await getOpmConfig()
    const opmUrl = config.opm_api_url
    if (!opmUrl) throw new Error('OPM API URL not configured')

    const firstName = conversation.wa_contacts?.display_name?.split(' ')[0] || 'Avatar'
    const isAudio = mediaType === 'audio'
    const uploadLabel = isAudio ? 'Uploading voice...' : 'Uploading video...'
    const watchingLabel = isAudio ? `${firstName} is listening...` : `${firstName} is watching your message...`
    const preset = isAudio ? 'echo' : (config.opm_preset || 'celebrity_ceo')

    const blobType = (mediaBlob.type || '').toLowerCase()
    let ext = 'webm'
    if (blobType.includes('aac')) ext = 'aac'
    else if (blobType.includes('m4a')) ext = 'm4a'
    else if (blobType.includes('mp4')) ext = 'mp4'
    else if (blobType.includes('webm')) ext = 'webm'
    else if (blobType.includes('ogg')) ext = 'ogg'

    const fileName = `capture.${ext}`

    onStage('\uD83D\uDCE1', uploadLabel, 10)

    const formData = new FormData()
    formData.append('video', mediaBlob, fileName)
    formData.append('session_id', conversation.id || '')
    formData.append('preset', preset)
    if (conversation.wa_contacts?.display_name) {
      formData.append('contact_name', conversation.wa_contacts.display_name)
    }
    if (opts.orientation) {
      formData.append('orientation', String(opts.orientation))
    }

    const submitRes = await fetch(`${opmUrl}/analyze`, {
      method: 'POST',
      body: formData,
    })

    if (!submitRes.ok) {
      const errData = await submitRes.json().catch(() => ({}))
      throw new Error(errData.error || 'opm_submit_failed')
    }

    const submitData = await submitRes.json()
    const jobId = submitData.job_id
    const startTime = Date.now()
    let jobComplete = false

    onStage('\uD83D\uDD2C', watchingLabel, 25)

    while (Date.now() - startTime < OPM_CLIENT_TIMEOUT_MS) {
      await delay(OPM_CLIENT_POLL_INTERVAL_MS)
      const statusRes = await fetch(`${opmUrl}/status/${jobId}`)
      if (!statusRes.ok) continue

      const statusData = await statusRes.json()
      const jobStatus = String(statusData.status || '').toLowerCase()
      const stage = String(statusData.stage || '').toLowerCase()

      if (jobStatus === 'complete' || jobStatus === 'completed' || jobStatus === 'done') {
        jobComplete = true
        break
      }
      if (jobStatus === 'failed' || jobStatus === 'error') {
        throw new Error(statusData.error || 'processing_error')
      }

      if (stage === 'cygnus' || stage === 'extracting' || jobStatus === 'processing') {
        onStage('\uD83D\uDD2C', watchingLabel, 35)
      } else if (stage === 'oracle' || stage === 'detecting') {
        onStage('\uD83E\uDDE0', `${firstName} is reading your expressions...`, 55)
      } else if (stage === 'lucid' || stage === 'interpreting') {
        onStage('\uD83E\uDDE0', `${firstName} is reading your expressions...`, 70)
      } else if (stage === 'trace' || stage === 'finalizing') {
        onStage('\uD83D\uDCAC', `${firstName} is composing a response...`, 85)
      } else {
        const elapsed = Date.now() - startTime
        const progress = Math.min(25 + Math.floor((elapsed / OPM_CLIENT_TIMEOUT_MS) * 60), 85)
        onStage('\uD83D\uDD2C', watchingLabel, progress)
      }
    }

    if (!jobComplete) {
      throw new Error('processing_timeout')
    }

    onStage('\uD83D\uDCAC', `${firstName} is composing a response...`, 95)
    const resultsRes = await fetch(`${opmUrl}/results/${jobId}`)
    if (!resultsRes.ok) {
      throw new Error('opm_results_failed')
    }

    const rawResults = await resultsRes.json()
    return normalizeOpmResponse(rawResults)
  }

  async function sendVideoBlob() {
    if (!conversationId || !conversation || !videoBlobRef.current) return

    const blob = videoBlobRef.current
    const durationSeconds = previewDuration || Math.max(1, recordingSeconds)
    const tempId = `temp-video-${Date.now()}`
    const localBlobUrl = previewUrl || URL.createObjectURL(blob)

    const optimisticMessage: Message = {
      id: tempId,
      sender: 'contact',
      type: 'video',
      content: '[Video message]',
      media_url: localBlobUrl,
      duration_sec: durationSeconds,
      created_at: new Date().toISOString(),
      _pending: true,
      _localBlobUrl: localBlobUrl,
    }

    onMessageSent(optimisticMessage)
    onSending(true)
    onError(null)
    setProcessingStage({ emoji: '\uD83D\uDCE1', text: 'Uploading video...', progress: 10 })

    const doSend = async () => {
      onMessageUpdate(tempId, { _pending: true, _failed: false, _errorMessage: undefined, _retryFn: undefined })
      onSending(true)

      try {
        const contentType = blob.type || 'video/webm'
        const [mediaUrl, opmResponse] = await Promise.all([
          uploadVideoToStorage(conversation, blob, contentType),
          callOpmApi(blob, (emoji, text, progress) => {
            setProcessingStage({ emoji, text, progress })
          }, 'video').catch((error) => {
            console.error('[Video] OPM analysis failed:', error)
            return null
          }),
        ])

        if (!mediaUrl) throw new Error('upload failed')

        const transcript = opmResponse?.transcript?.trim() || '[Video message]'

        const message = (await sendMessage(
          conversationId,
          'contact',
          'video',
          transcript,
          mediaUrl,
          durationSeconds
        )) as Message

        onMessageUpdate(tempId, {
          id: message.id,
          content: transcript,
          media_url: mediaUrl,
          duration_sec: durationSeconds,
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
          transcript: transcript !== '[Video message]' ? transcript : null,
          primaryEmotion: opmResponse?.perception?.primary_emotion ?? null,
          secondaryEmotion: opmResponse?.perception?.secondary_emotion ?? null,
          firedRules: opmResponse?.fired_rules ?? null,
          behavioralSummary: opmResponse?.behavioral_summary ?? opmResponse?.perception?.behavioral_summary ?? opmResponse?.interpretation?.behavioral_summary ?? null,
          conversationHooks: opmResponse?.conversation_hooks ?? opmResponse?.interpretation?.conversation_hooks ?? null,
          recommendedTone: opmResponse?.recommended_tone ?? opmResponse?.perception?.recommended_tone ?? opmResponse?.interpretation?.recommended_tone ?? null,
          prosodicSummary: opmResponse?.prosodic_summary ?? null,
          facialAnalysis: opmResponse?.perception?.facial_analysis ?? null,
          bodyLanguage: opmResponse?.perception?.body_language ?? null,
          mediaType: 'video',
          videoDurationSec: durationSeconds,
        }).catch((logErr) => console.warn('[perception-log]', logErr.message))

        if (transcript && transcript !== '[Video message]') {
          onTranscript(message.id, transcript)
        }

        const seedText = transcript !== '[Video message]' ? transcript : 'The user sent a video message.'
        const videoReplied = await sendAvatarReply(seedText, {
          isVideo: true,
          videoDurationSec: durationSeconds,
          perception: opmResponse,
          userMessageId: message.id,
        })

        if (videoReplied) maybeAvatarReact(message.id)
      } catch (sendError: any) {
        console.error('[sendVideoBlob]', sendError)
        onMessageUpdate(tempId, {
          _pending: false,
          _failed: true,
          _errorMessage: sendError?.message || 'Unable to send this video.',
          _retryFn: () => {
            onMessageUpdate(tempId, { _pending: true, _failed: false, _errorMessage: undefined, _retryFn: undefined })
            void doSend()
          },
        })
      } finally {
        onSending(false)
        setProcessingStage(null)
      }
    }

    await doSend()

    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current)
      return null
    })
    setPreviewDuration(0)
    videoBlobRef.current = null
    setVideoOverlayOpen(false)
    stopVideoPreview()
  }

  async function openVideoOverlay() {
    setVideoOverlayOpen(true)
    setPreviewDuration(0)
    setRecordingSeconds(0)
    setProcessingStage(null)
    videoBlobRef.current = null
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current)
      return null
    })

    try {
      await startVideoPreview()
    } catch (error) {
      console.error(error)
      setVideoOverlayOpen(false)
      onError('Camera and microphone access are required for video messages.')
    }
  }

  async function retakeVideo() {
    stopVideoPreview()
    videoBlobRef.current = null
    setPreviewDuration(0)
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current)
      return null
    })
    if (previewVideoRef.current) {
      previewVideoRef.current.pause()
      previewVideoRef.current.src = ''
    }
    await startVideoPreview()
  }

  function closeVideoOverlay() {
    stopTimer()
    if (videoRecorderRef.current && videoRecorderRef.current.state !== 'inactive') {
      videoRecorderRef.current.stop()
    }
    stopVideoPreview()
    setRecordingMode('idle')
    setRecordingSeconds(0)
    setVideoOverlayOpen(false)
    setPreviewDuration(0)
    setProcessingStage(null)
    videoBlobRef.current = null
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current)
      return null
    })
  }

  useEffect(() => {
    return () => {
      stopTimer()
      stopVideoPreview()
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  return {
    videoOverlayOpen,
    recordingMode,
    recordingSeconds,
    previewUrl,
    previewDuration,
    processingStage,
    liveVideoRef,
    previewVideoRef,
    pickVideoMimeType,
    startVideoPreview,
    startVideoRecording,
    stopVideoRecording,
    enterVideoPreview,
    correctVideoOrientation,
    callOpmApi,
    openVideoOverlay,
    closeVideoOverlay,
    retakeVideo,
    sendVideoBlob,
  }
}
