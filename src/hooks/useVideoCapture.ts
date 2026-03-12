import { useRef, useState, type MutableRefObject } from 'react'
import { sendMessage, createPerceptionLog } from '../lib/api'
import {
  getFileExtension,
  uploadMediaToStorage, callOpmApi, correctVideoOrientation,
} from '../lib/mediaUtils'
import { getAvatarFirstName } from '../lib/voiceDelay'

type ValidationTone = '' | 'warning' | 'success' | 'error'
type VideoOverlayMode = 'live' | 'preview'

interface Message {
  id: string
  sender: 'contact' | 'avatar'
  type: 'text' | 'voice' | 'video' | 'image'
  content: string | null
  media_url: string | null
  duration_sec: number | null
  created_at: string
}

interface ConversationRef {
  id: string
  owner_id: string
  contact_id: string
}

interface SharedRecordingState {
  setRecordingMode: (mode: 'idle' | 'recording' | 'stopping') => void
  setCaptureKind: (kind: 'none' | 'voice' | 'video') => void
  setRecordingSeconds: (seconds: number | ((prev: number) => number)) => void
  recordTimerRef: MutableRefObject<number | null>
  speechRecognitionRef: MutableRefObject<{ stop(): void } | null>
  browserTranscriptRef: MutableRefObject<string>
  audioStartRef: MutableRefObject<number>
  stopRecordingTimer: () => void
  startSpeechRecognition: () => void
}

interface UseVideoCaptureOptions {
  conversationId: string | undefined
  conversation: ConversationRef | null
  avatarDisplayName: string | undefined
  shared: SharedRecordingState
  onSending: (sending: boolean) => void
  onError: (error: string | null) => void
  onMessageSent: (message: Message) => void
  onTranscript: (messageId: string, transcript: string) => void
  onProcessingStage: (emoji: string, text: string) => void
  sendAvatarReply: (text: string, options?: { useVoice?: boolean; isVideo?: boolean; videoDurationSec?: number; perception?: any }) => Promise<boolean>
}

const VIDEO_MAX_SECONDS = 300
const PROGRESS_RING_CIRCUMFERENCE = 779.4
const TIME_WARNING_THRESHOLD = 30

const isIOSSafari = typeof navigator !== 'undefined'
  && /iPad|iPhone|iPod/.test(navigator.userAgent)
  && !(window as any).MSStream

function pickVideoMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const options = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
  return options.find((o) => MediaRecorder.isTypeSupported(o)) || ''
}

export function useVideoCapture({
  conversationId,
  conversation,
  avatarDisplayName,
  shared,
  onSending,
  onError,
  onMessageSent,
  onTranscript,
  onProcessingStage,
  sendAvatarReply,
}: UseVideoCaptureOptions) {
  const {
    setRecordingMode, setCaptureKind, setRecordingSeconds,
    recordTimerRef, speechRecognitionRef, browserTranscriptRef, audioStartRef,
    stopRecordingTimer, startSpeechRecognition,
  } = shared

  const avatarFirstName = getAvatarFirstName(avatarDisplayName)

  // Video-specific state
  const [videoOverlayOpen, setVideoOverlayOpen] = useState(false)
  const [videoOverlayMode, setVideoOverlayMode] = useState<VideoOverlayMode>('live')
  const [videoPermissionPending, setVideoPermissionPending] = useState(false)
  const [videoValidationText, setVideoValidationText] = useState('Position your face in the circle')
  const [videoValidationTone, setVideoValidationTone] = useState<ValidationTone>('')
  const [videoCanRecord, setVideoCanRecord] = useState(false)
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null)
  const [videoDraftSeconds, setVideoDraftSeconds] = useState(0)
  const [videoTimeWarning, setVideoTimeWarning] = useState(false)
  const [progressRingOffset, setProgressRingOffset] = useState(PROGRESS_RING_CIRCUMFERENCE)
  const [manualRotation, setManualRotation] = useState(0)

  // Video-specific refs
  const videoRecorderRef = useRef<MediaRecorder | null>(null)
  const videoStreamRef = useRef<MediaStream | null>(null)
  const videoChunksRef = useRef<Blob[]>([])
  const videoPreviewRef = useRef<HTMLVideoElement>(null)
  const faceCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const videoValidationLockRef = useRef(0)
  const lastVideoValidationRef = useRef('')
  const videoDraftBlobRef = useRef<Blob | null>(null)
  const videoDraftTranscriptRef = useRef('')
  const faceValidationIntervalRef = useRef<number | null>(null)
  const videoSecondsRef = useRef(0)
  const videoStreamIsLandscapeRef = useRef(false)

  function setVideoValidation(text: string, tone: ValidationTone, blockRecording: boolean) {
    const now = Date.now()
    if (!blockRecording && now < videoValidationLockRef.current && text !== lastVideoValidationRef.current) {
      return
    }
    if (text !== lastVideoValidationRef.current && tone && navigator.vibrate) {
      navigator.vibrate(blockRecording ? [100, 50, 100] : 80)
    }
    if (text !== lastVideoValidationRef.current) {
      videoValidationLockRef.current = now + 3000
    }
    lastVideoValidationRef.current = text
    setVideoValidationText(text)
    setVideoValidationTone(tone)
    setVideoCanRecord(!blockRecording)
  }

  // ML-based face detection via the browser FaceDetector API (Chromium).
  // Falls back to brightness-only check on unsupported browsers.
  const faceDetectorRef = useRef<any>(null)
  const faceDetectorSupported = useRef<boolean | null>(null)

  function initFaceDetector() {
    if (faceDetectorSupported.current !== null) return
    try {
      if (typeof (window as any).FaceDetector === 'function') {
        faceDetectorRef.current = new (window as any).FaceDetector({ fastMode: true, maxDetectedFaces: 1 })
        faceDetectorSupported.current = true
      } else {
        faceDetectorSupported.current = false
      }
    } catch {
      faceDetectorSupported.current = false
    }
  }

  async function runFaceValidation() {
    const video = videoPreviewRef.current
    if (!video || !videoStreamRef.current || videoOverlayMode !== 'live') return
    if (!video.videoWidth || !video.videoHeight) return

    // Check brightness via a small canvas sample
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
    let brightnessSum = 0
    let totalPixels = 0

    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const dx = x - centerX
        const dy = y - centerY
        if (dx * dx + dy * dy <= radius * radius) {
          const index = (y * width + x) * 4
          brightnessSum += (data[index] + data[index + 1] + data[index + 2]) / 3
          totalPixels += 1
        }
      }
    }

    const averageBrightness = totalPixels > 0 ? brightnessSum / totalPixels : 0

    if (averageBrightness < 40) {
      setVideoValidation(`We need more light so ${avatarFirstName} can see you clearly`, 'warning', true)
      return
    }

    // Try ML-based FaceDetector (works across all skin tones)
    initFaceDetector()
    if (faceDetectorSupported.current && faceDetectorRef.current) {
      try {
        const faces = await faceDetectorRef.current.detect(video)
        if (!faces || faces.length === 0) {
          setVideoValidation('Position your face in the circle', '', true)
          return
        }

        const face = faces[0]
        const bb = face.boundingBox
        const faceCenterX = (bb.x + bb.width / 2) / video.videoWidth
        const faceCenterY = (bb.y + bb.height / 2) / video.videoHeight
        const faceArea = (bb.width * bb.height) / (video.videoWidth * video.videoHeight)

        // Check centering (face center should be near frame center)
        const offsetX = Math.abs(faceCenterX - 0.5)
        const offsetY = Math.abs(faceCenterY - 0.5)

        if (offsetX > 0.25 || offsetY > 0.25) {
          setVideoValidation('Center your face in the circle', 'warning', true)
          return
        }

        if (faceArea < 0.03) {
          setVideoValidation('Move closer to the camera', 'warning', true)
          return
        }

        if (averageBrightness < 70) {
          setVideoValidation('A bit more light would help', 'warning', false)
          return
        }

        setVideoValidation('Ready to record', 'success', false)
        return
      } catch {
        // FaceDetector failed (e.g. ImageBitmap issue) — fall through to fallback
      }
    }

    // Fallback: brightness-based presence check (no skin-color dependency)
    // Instead of checking skin color, we detect motion/contrast in the center region
    let contrastSum = 0
    let contrastPixels = 0
    for (let y = 1; y < height - 1; y += 2) {
      for (let x = 1; x < width - 1; x += 2) {
        const dx = x - centerX
        const dy = y - centerY
        if (dx * dx + dy * dy <= radius * radius) {
          const index = (y * width + x) * 4
          const curr = (data[index] + data[index + 1] + data[index + 2]) / 3
          const right = (data[index + 4] + data[index + 5] + data[index + 6]) / 3
          const below = (data[((y + 1) * width + x) * 4] + data[((y + 1) * width + x) * 4 + 1] + data[((y + 1) * width + x) * 4 + 2]) / 3
          contrastSum += Math.abs(curr - right) + Math.abs(curr - below)
          contrastPixels += 1
        }
      }
    }

    const avgContrast = contrastPixels > 0 ? contrastSum / contrastPixels : 0

    // A face has more local contrast than an empty wall
    if (avgContrast < 3) {
      setVideoValidation('Position your face in the circle', '', true)
      return
    }

    if (averageBrightness < 70) {
      setVideoValidation('A bit more light would help', 'warning', false)
      return
    }

    setVideoValidation('Ready to record', 'success', false)
  }

  async function startLiveVideoRecording() {
    if (!conversation || !videoStreamRef.current) return

    try {
      const mimeType = pickVideoMimeType()
      const recorder = mimeType
        ? new MediaRecorder(videoStreamRef.current, { mimeType })
        : new MediaRecorder(videoStreamRef.current)
      videoRecorderRef.current = recorder
      videoChunksRef.current = []
      browserTranscriptRef.current = ''
      videoSecondsRef.current = 0

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) videoChunksRef.current.push(event.data)
      }
      recorder.start(250)
      startSpeechRecognition()
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
      setVideoTimeWarning(false)
      setProgressRingOffset(PROGRESS_RING_CIRCUMFERENCE)

      recordTimerRef.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - audioStartRef.current) / 1000)
        videoSecondsRef.current = elapsed
        setRecordingSeconds(elapsed)

        // Progress ring
        const progress = elapsed / VIDEO_MAX_SECONDS
        const offset = PROGRESS_RING_CIRCUMFERENCE * (1 - progress)
        setProgressRingOffset(Math.max(offset, 0))

        // Time warning at 30s remaining
        const remaining = VIDEO_MAX_SECONDS - elapsed
        if (remaining <= TIME_WARNING_THRESHOLD) {
          setVideoTimeWarning(true)
        }

        // Auto-stop at max duration
        if (elapsed >= VIDEO_MAX_SECONDS) {
          void stopLiveVideoRecording()
        }
      }, 250)
    } catch (videoError) {
      console.error(videoError)
      onError('Camera access is required to record video.')
    }
  }

  async function stopLiveVideoRecording() {
    if (!videoRecorderRef.current || !conversation || !conversationId) return

    stopRecordingTimer()
    speechRecognitionRef.current?.stop?.()
    speechRecognitionRef.current = null
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
    setVideoTimeWarning(false)

    if (!blob || videoSecondsRef.current < 1) return

    const videoTranscript = browserTranscriptRef.current.trim()
    browserTranscriptRef.current = ''
    const duration = Math.max(1, Math.round((Date.now() - audioStartRef.current) / 1000))

    // Orientation correction BEFORE preview (like ANIMA Connect)
    try {
      setVideoValidationText('Processing video...')
      setVideoValidationTone('')

      let correctedBlob = blob
      if (!isIOSSafari || !videoStreamIsLandscapeRef.current) {
        const file = new File([blob], `recorded-video.${getFileExtension(blob, 'webm')}`, {
          type: blob.type || 'video/webm',
        })
        try {
          const correctedFile = await correctVideoOrientation(file)
          correctedBlob = correctedFile
        } catch (err) {
          console.warn('[VideoRotation] Correction failed, using raw blob:', err)
        }
      }

      const previewUrl = URL.createObjectURL(correctedBlob)
      videoDraftBlobRef.current = correctedBlob instanceof File
        ? correctedBlob
        : new File([correctedBlob], `recorded-video.${getFileExtension(correctedBlob, 'webm')}`, {
            type: correctedBlob.type || 'video/webm',
          })
      videoDraftTranscriptRef.current = videoTranscript
      setVideoDraftSeconds(duration)
      setManualRotation(0)
      setVideoPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current)
        return previewUrl
      })
      setVideoOverlayMode('preview')
      setVideoValidationText('Preview — tap send or cancel')
      setVideoValidationTone('success')
    } catch (videoSendError) {
      console.error(videoSendError)
      onError('Unable to prepare this recorded video.')
    }
  }

  function rotatePreview() {
    setManualRotation((prev) => (prev + 90) % 360)
    setVideoValidationText(
      ((manualRotation + 90) % 360)
        ? `Rotated ${(manualRotation + 90) % 360}° — tap send or cancel`
        : 'Preview — tap send or cancel'
    )
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
    videoDraftTranscriptRef.current = ''
    speechRecognitionRef.current?.stop?.()
    speechRecognitionRef.current = null
    videoSecondsRef.current = 0
    setRecordingMode('idle')
    setCaptureKind('none')
    setRecordingSeconds(0)
    setVideoOverlayOpen(false)
    setVideoOverlayMode('live')
    setVideoPermissionPending(false)
    setVideoValidationText('Position your face in the circle')
    setVideoValidationTone('')
    setVideoCanRecord(false)
    setVideoTimeWarning(false)
    setProgressRingOffset(PROGRESS_RING_CIRCUMFERENCE)
    setManualRotation(0)
    setVideoPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current)
      return null
    })
    videoStreamIsLandscapeRef.current = false
    const video = videoPreviewRef.current
    if (video) {
      video.pause()
      video.srcObject = null
      video.src = ''
      video.style.transform = ''
    }
  }

  async function openVideoOverlay() {
    if (videoOverlayOpen) return
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

      // iOS Safari landscape stream detection
      videoStreamIsLandscapeRef.current = false
      const videoTrack = stream.getVideoTracks()[0]
      if (videoTrack) {
        const settings = videoTrack.getSettings()
        const sw = settings.width || 0
        const sh = settings.height || 0
        if (sw > sh && sh > 0) {
          videoStreamIsLandscapeRef.current = true
          if (video) {
            const scale = Math.max(sw / sh, 1.35)
            video.style.transform = `scaleX(-1) rotate(-90deg) scale(${scale.toFixed(2)})`
          }
        }
      }

      setVideoPermissionPending(false)
      setVideoValidationText('Position your face in the circle')
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

  async function sendRecordedVideoDraft() {
    if (!videoDraftBlobRef.current || !conversationId || !conversation) return

    onSending(true)
    onError(null)
    try {
      const file = videoDraftBlobRef.current instanceof File
        ? videoDraftBlobRef.current
        : new File([videoDraftBlobRef.current], `recorded-video.${getFileExtension(videoDraftBlobRef.current, 'webm')}`, {
            type: videoDraftBlobRef.current.type || 'video/webm',
          })

      const opmOpts: { orientation?: number } = {}
      if (manualRotation) {
        opmOpts.orientation = manualRotation
      } else if (isIOSSafari && videoStreamIsLandscapeRef.current) {
        opmOpts.orientation = 90
      }

      const [mediaUrl, opmResponse] = await Promise.all([
        uploadMediaToStorage(conversation, file, 'video', true),
        callOpmApi(conversation, file, 'video', {
          ...opmOpts,
          avatarFirstName,
          onStage: (emoji, text, _progress) => onProcessingStage(emoji, text),
        }).catch((error) => {
          console.error('[Video] OPM recorded video analysis failed:', error)
          return null
        }),
      ])
      if (!mediaUrl) throw new Error('upload failed')
      const transcript = opmResponse?.transcript?.trim() || ''

      const contentText = transcript || '[Recorded video]'
      const message = (await sendMessage(
        conversationId,
        'contact',
        'video',
        contentText,
        mediaUrl,
        videoDraftSeconds
      )) as Message

      onMessageSent(message)

      createPerceptionLog({
        messageId: message.id,
        conversationId: conversation.id,
        contactId: conversation.contact_id,
        ownerId: conversation.owner_id,
        transcript: transcript || null,
        audioDurationSec: videoDraftSeconds,
        primaryEmotion: opmResponse?.perception?.primary_emotion ?? null,
        secondaryEmotion: opmResponse?.perception?.secondary_emotion ?? null,
        firedRules: opmResponse?.fired_rules ?? null,
        behavioralSummary: opmResponse?.interpretation?.behavioral_summary ?? null,
        conversationHooks: opmResponse?.interpretation?.conversation_hooks ?? null,
        prosodicSummary: opmResponse?.prosodic_summary ?? null,
        mediaType: 'video',
      }).catch((logErr) => console.warn('[perception-log]', logErr.message))

      if (transcript) {
        onTranscript(message.id, transcript)
      }

      onProcessingStage('', '')  // clear inline processing
      closeVideoOverlay()
      await sendAvatarReply(transcript || 'a recorded video', {
        useVoice: false,
        isVideo: true,
        videoDurationSec: videoDraftSeconds,
        perception: opmResponse,
      })
    } catch (videoSendError: any) {
      console.error(videoSendError)
      onError(videoSendError?.message || 'processing_error')
    } finally {
      onSending(false)
    }
  }

  return {
    // State
    videoOverlayOpen,
    videoOverlayMode,
    videoPermissionPending,
    videoValidationText,
    videoValidationTone,
    videoCanRecord,
    videoPreviewUrl,
    videoDraftSeconds,
    videoTimeWarning,
    progressRingOffset,
    manualRotation,

    // Constants
    PROGRESS_RING_CIRCUMFERENCE,

    // Refs (exposed for JSX binding)
    videoPreviewRef,
    videoStreamRef,
    faceValidationIntervalRef,

    // Functions
    openVideoOverlay,
    closeVideoOverlay,
    startLiveVideoRecording,
    stopLiveVideoRecording,
    sendRecordedVideoDraft,
    rotatePreview,
  }
}
