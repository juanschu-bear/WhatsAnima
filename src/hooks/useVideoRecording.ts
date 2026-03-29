import { useEffect, useRef, useState } from 'react'
import { createPerceptionLog, sendMessage } from '../lib/api'
import { delay, uploadMediaToStorage } from '../lib/mediaUtils'

const VIDEO_MAX_SECONDS = 300
const PROGRESS_RING_CIRCUMFERENCE = 779.4
const OPM_CLIENT_TIMEOUT_MS = 180000
const OPM_CLIENT_POLL_INTERVAL_MS = 3000

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

type RecordingMode = 'idle' | 'recording' | 'stopping'
type ValidationType = '' | 'warning' | 'error' | 'success'

interface Message {
  id: string
  sender: 'contact' | 'avatar'
  type: 'text' | 'voice' | 'video' | 'image' | 'call_summary' | 'system'
  content: string | null
  media_url: string | null
  duration_sec: number | null
  created_at: string
  isGalleryVideo?: boolean
  videoNeedsRotation?: boolean
  videoRotationScale?: number
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
  wa_owners?: { display_name?: string | null } | null
}

interface StageState {
  emoji: string
  text: string
  progress: number
}

interface OpmNormalizedResponse {
  transcript: string
  perception: Record<string, any>
  interpretation: Record<string, any>
  session: any
  analysisType: 'echo' | 'standard' | 'legacy'
  fired_rules: any[]
  duration_sec?: number | null
  processing_ms?: number | null
  skipped_reason?: string | null
  prosodic_summary?: Record<string, any> | null
  behavioral_summary?: string | null
  conversation_hooks?: any[] | null
  recommended_tone?: string | null
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

function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0))
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`
}

function normalizeOpmResponse(raw: any): OpmNormalizedResponse {
  console.log('[OPM Normalize] Top-level keys:', Object.keys(raw || {}))

  const unwrapped = raw?.result || raw?.data || raw || {}
  const echoAnalysis = unwrapped.echo_analysis || null
  const standardAnalysis = unwrapped.standard_analysis || null

  if (echoAnalysis || standardAnalysis) {
    const isEcho = !!echoAnalysis
    const analysis = echoAnalysis || standardAnalysis
    const analysisType: 'echo' | 'standard' = isEcho ? 'echo' : 'standard'

    console.log('[OPM Normalize] NEW structure detected, analysisType:', analysisType)

    const audioFeatures = analysis.audio_features || {}
    const firedRules = analysis.fired_rules || []
    const transcript = firstNonEmptyString([
      audioFeatures.transcript,
      analysis.transcript,
      unwrapped.transcript,
      raw?.transcript,
    ])
    const skippedReason = analysis.skipped_reason || null

    console.log(
      '[OPM Normalize] fired_rules:',
      firedRules.length,
      '| transcript length:',
      transcript.length,
      '| skipped_reason:',
      skippedReason
    )

    const sessionObj = unwrapped.session || null
    const lucidText =
      sessionObj?.lucid_interpretation?.interpretation ||
      sessionObj?.session_interpretation?.interpretation ||
      ''
    const sessionPatterns = sessionObj?.session_analysis?.session_patterns || []

    const perception = {
      primary_emotion: audioFeatures.primary_emotion || null,
      secondary_emotion: audioFeatures.secondary_emotion || null,
      valence: audioFeatures.valence != null ? audioFeatures.valence : null,
      arousal: audioFeatures.arousal != null ? audioFeatures.arousal : null,
      confidence: audioFeatures.confidence != null ? audioFeatures.confidence : null,
      behavioral_summary: lucidText || null,
      session_patterns: sessionPatterns,
      transcript,
    }

    let interpretation: Record<string, any>
    if (lucidText) {
      interpretation = {
        behavioral_summary: lucidText,
        conversation_hooks: sessionPatterns.map((pattern: any) =>
          typeof pattern === 'string' ? pattern : pattern?.pattern || pattern?.description || JSON.stringify(pattern)
        ),
        lucid_raw: true,
      }
    } else {
      interpretation = {
        behavioral_summary: '',
        conversation_hooks: [],
      }
    }

    const mergedSession = sessionObj ? { ...sessionObj } : { session_analysis: {} as Record<string, any> }
    if (!mergedSession.session_analysis) mergedSession.session_analysis = {}
    if (isEcho) {
      mergedSession.session_analysis.echo_rules = { fired_rules: firedRules }
    } else {
      mergedSession.session_analysis.cross_modal_rules = { fired_rules: firedRules }
    }

    const normalized: OpmNormalizedResponse = {
      transcript,
      perception,
      interpretation,
      session: mergedSession,
      analysisType,
      duration_sec: analysis.duration_sec || null,
      processing_ms: analysis.processing_ms || null,
      skipped_reason: skippedReason,
      prosodic_summary: audioFeatures.prosodic_summary || null,
      fired_rules: firedRules,
      behavioral_summary: interpretation.behavioral_summary || null,
      conversation_hooks: interpretation.conversation_hooks || [],
      recommended_tone: null,
    }

    console.log(
      '[OPM Normalize] FINAL (new) — analysisType:',
      analysisType,
      '| fired_rules:',
      firedRules.length,
      '| lucid_raw:',
      !!interpretation.lucid_raw,
      '| skipped_reason:',
      skippedReason,
      '| duration_sec:',
      normalized.duration_sec
    )

    return normalized
  }

  console.log('[OPM Normalize] OLD/legacy structure detected')
  const sessionObj = unwrapped.session || raw?.session || null
  const lucidText =
    sessionObj?.lucid_interpretation?.interpretation ||
    sessionObj?.session_interpretation?.interpretation ||
    unwrapped?.session_interpretation?.interpretation ||
    raw?.session_interpretation?.interpretation ||
    unwrapped?.interpretation?.interpretation ||
    ''
  const sessionPatterns =
    sessionObj?.session_analysis?.session_patterns ||
    unwrapped?.session_analysis?.session_patterns ||
    raw?.session_analysis?.session_patterns ||
    []
  const transcript = firstNonEmptyString([
    unwrapped?.transcript,
    raw?.transcript,
    unwrapped?.layers?.cygnus?.audio?.transcript?.text,
    raw?.layers?.cygnus?.audio?.transcript?.text,
  ])

  let perception: Record<string, any>
  let interpretation: Record<string, any>
  if (lucidText) {
    perception = {
      behavioral_summary: lucidText,
      session_patterns: sessionPatterns,
      transcript,
    }
    interpretation = {
      behavioral_summary: lucidText,
      conversation_hooks: sessionPatterns.map((pattern: any) =>
        typeof pattern === 'string' ? pattern : pattern?.pattern || pattern?.description || JSON.stringify(pattern)
      ),
      lucid_raw: true,
    }
  } else {
    perception = unwrapped?.perception || raw?.perception || {}
    interpretation = unwrapped?.interpretation || raw?.interpretation || {}
  }

  return {
    transcript,
    perception,
    interpretation,
    session: sessionObj || null,
    analysisType: 'legacy',
    fired_rules: [],
    behavioral_summary: interpretation.behavioral_summary || null,
    conversation_hooks: interpretation.conversation_hooks || [],
    recommended_tone: interpretation.recommended_tone || null,
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
  const [progressRingOffset, setProgressRingOffset] = useState(PROGRESS_RING_CIRCUMFERENCE)
  const [timeWarning, setTimeWarning] = useState(false)
  const [videoHint, setVideoHint] = useState('Tap to record')
  const [videoStatusText, setVideoStatusText] = useState('Preparing camera...')
  const [validationText, setValidationText] = useState('Position your face in the circle')
  const [validationType, setValidationType] = useState<ValidationType>('')
  const [canRecord, setCanRecord] = useState(false)
  const [previewMode, setPreviewMode] = useState(false)
  const [previewDuration, setPreviewDuration] = useState(0)
  const [processingStage, setProcessingStage] = useState<StageState | null>(null)
  const [processingMessageId, setProcessingMessageId] = useState<string | null>(null)

  const [previewCurrentTime, setPreviewCurrentTime] = useState(0)
  const [previewProgress, setPreviewProgress] = useState(0)
  const [previewPlaying, setPreviewPlaying] = useState(false)

  const videoPreviewRef = useRef<HTMLVideoElement | null>(null)
  const videoStreamRef = useRef<MediaStream | null>(null)
  const videoRecorderRef = useRef<MediaRecorder | null>(null)
  const videoChunksRef = useRef<Blob[]>([])
  const videoBlobRef = useRef<Blob | null>(null)
  const timerRef = useRef<number | null>(null)
  const stopResolverRef = useRef<((blob: Blob | null) => void) | null>(null)
  const startTimeRef = useRef(0)
  const pendingVideoDurationRef = useRef(0)

  const faceDetectionIntervalRef = useRef<number | null>(null)
  const faceCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const faceCtxRef = useRef<CanvasRenderingContext2D | null>(null)
  const validationLockedUntilRef = useRef(0)
  const lastValidationTextRef = useRef('')

  const videoStreamIsLandscapeRef = useRef(false)
  const videoStreamRotationScaleRef = useRef(1)
  const manualRotationDegreesRef = useRef(0)

  const isIOSSafari =
    typeof navigator !== 'undefined'
    && /iPad|iPhone|iPod/.test(navigator.userAgent)

  function isPortraitViewport() {
    if (window.matchMedia) {
      return window.matchMedia('(orientation: portrait)').matches
    }
    return window.innerHeight >= window.innerWidth
  }

  function getLandscapeRotationScale(width: number, height: number) {
    if (!width || !height) return 1.35
    return Math.max(width / height, 1.35)
  }

  function buildVideoTransform({ mirror = false, rotationDeg = 0, scale = 1 } = {}) {
    const transforms: string[] = []
    if (mirror) transforms.push('scaleX(-1)')
    if (rotationDeg) transforms.push(`rotate(${rotationDeg}deg)`)
    if (Math.abs(scale - 1) > 0.01) transforms.push(`scale(${scale.toFixed(2)})`)
    return transforms.join(' ')
  }

  function applyPreviewVideoTransform() {
    const preview = videoPreviewRef.current
    if (!preview) return
    const rotationDeg = (videoStreamIsLandscapeRef.current ? -90 : 0) + manualRotationDegreesRef.current
    const scale = videoStreamIsLandscapeRef.current ? videoStreamRotationScaleRef.current : 1
    preview.style.transform = buildVideoTransform({ mirror: true, rotationDeg, scale })
  }

  function refreshVideoStreamOrientation() {
    const preview = videoPreviewRef.current
    const videoTrack = videoStreamRef.current ? videoStreamRef.current.getVideoTracks()[0] : null
    const settings = videoTrack && videoTrack.getSettings ? videoTrack.getSettings() : {}
    const sw = settings.width || 0
    const sh = settings.height || 0
    const vw = preview?.videoWidth || 0
    const vh = preview?.videoHeight || 0
    const hasLandscapeFrames = (sw > sh && sh > 0) || (vw > vh && vh > 0)

    videoStreamIsLandscapeRef.current = Boolean(isIOSSafari && isPortraitViewport() && hasLandscapeFrames)
    videoStreamRotationScaleRef.current = videoStreamIsLandscapeRef.current
      ? getLandscapeRotationScale(sw > sh ? sw : vw, sw > sh ? sh : vh)
      : 1
    applyPreviewVideoTransform()
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

  async function requestVideoCaptureStream() {
    return navigator.mediaDevices.getUserMedia({
      video: VIDEO_CAPTURE_VIDEO_CONSTRAINTS,
      audio: VIDEO_CAPTURE_AUDIO_CONSTRAINTS,
    })
  }

  async function attachVideoPreviewStream(stream: MediaStream) {
    const preview = videoPreviewRef.current
    if (!preview) return

    videoStreamRef.current = stream
    preview.srcObject = stream
    preview.setAttribute('muted', '')
    preview.muted = true

    try {
      await preview.play()
    } catch {}

    videoStreamIsLandscapeRef.current = false
    videoStreamRotationScaleRef.current = 1
    preview.addEventListener('loadedmetadata', refreshVideoStreamOrientation, { once: true })
    refreshVideoStreamOrientation()
  }

  async function ensureVideoCaptureAudioTracks() {
    if (!videoStreamRef.current) return 0

    let audioTrackCount = videoStreamRef.current.getAudioTracks().length
    if (audioTrackCount > 0) return audioTrackCount

    videoStreamRef.current.getTracks().forEach((track) => track.stop())
    const replacementStream = await requestVideoCaptureStream()
    await attachVideoPreviewStream(replacementStream)
    audioTrackCount = videoStreamRef.current?.getAudioTracks().length || 0
    return audioTrackCount
  }

  function getPreviewDurationSeconds() {
    const preview = videoPreviewRef.current
    if (Number.isInteger(pendingVideoDurationRef.current) && pendingVideoDurationRef.current > 0) {
      return pendingVideoDurationRef.current
    }
    if (preview && Number.isFinite(preview.duration) && preview.duration > 0) {
      return Math.floor(preview.duration)
    }
    return 0
  }

  function updatePreviewControls() {
    const preview = videoPreviewRef.current
    if (!preview) return
    const duration = getPreviewDurationSeconds()
    const currentTime = Math.min(preview.currentTime || 0, duration || pendingVideoDurationRef.current || 0)
    const progress = duration > 0 ? currentTime / duration : 0

    setPreviewCurrentTime(currentTime)
    setPreviewProgress(Math.max(0, Math.min(1, progress)))
    setPreviewPlaying(!(preview.paused || preview.ended))
  }

  function stopFaceDetection() {
    if (faceDetectionIntervalRef.current) {
      window.clearInterval(faceDetectionIntervalRef.current)
      faceDetectionIntervalRef.current = null
    }
  }

  function setValidation(text: string, type: ValidationType, blockRecording: boolean) {
    const now = Date.now()

    if (!blockRecording && now < validationLockedUntilRef.current && text !== lastValidationTextRef.current) {
      return
    }

    if (text !== lastValidationTextRef.current && type && navigator.vibrate) {
      if (blockRecording) navigator.vibrate([100, 50, 100])
      else navigator.vibrate(80)
    }

    if (text !== lastValidationTextRef.current) {
      validationLockedUntilRef.current = now + 3000
    }

    lastValidationTextRef.current = text
    setValidationText(text)
    setValidationType(type)
    if (blockRecording) {
      setCanRecord(false)
    }
  }

  function runFaceValidation() {
    const preview = videoPreviewRef.current
    const stream = videoStreamRef.current
    if (!preview?.videoWidth || !stream) return

    if (!faceCanvasRef.current) {
      faceCanvasRef.current = document.createElement('canvas')
      faceCtxRef.current = faceCanvasRef.current.getContext('2d', { willReadFrequently: true })
    }
    const faceCanvas = faceCanvasRef.current
    const faceCtx = faceCtxRef.current
    if (!faceCtx) return

    const w = 160
    const h = 160
    faceCanvas.width = w
    faceCanvas.height = h
    faceCtx.drawImage(preview, 0, 0, w, h)

    const imageData = faceCtx.getImageData(0, 0, w, h)
    const data = imageData.data

    const centerX = w / 2
    const centerY = h / 2
    const radius = w * 0.35

    let skinPixels = 0
    let totalPixels = 0
    let brightnessSum = 0
    let skinXSum = 0
    let skinYSum = 0
    let leftSkinPixels = 0
    let rightSkinPixels = 0

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        const brightness = (r + g + b) / 3

        const dx = x - centerX
        const dy = y - centerY
        if (dx * dx + dy * dy <= radius * radius) {
          brightnessSum += brightness
          totalPixels++
        }

        if (r > 60 && g > 40 && b > 20 && r > g && r > b
          && Math.abs(r - g) > 10 && brightness > 50 && brightness < 240) {
          skinPixels++
          skinXSum += x
          skinYSum += y
          if (x < centerX) leftSkinPixels++
          else rightSkinPixels++
        }
      }
    }

    const totalFramePixels = w * h
    const skinRatio = skinPixels / totalFramePixels
    const avgBrightness = totalPixels > 0 ? brightnessSum / totalPixels : 0
    const ceoName = conversation?.wa_owners?.display_name || 'the CEO'

    if (avgBrightness < 40) {
      setValidation(`We need more light so ${ceoName} can see you clearly`, 'warning', true)
      return
    }

    if (skinRatio < 0.02) {
      setValidation('Position your face in the circle', '', true)
      return
    }

    const faceCenterX = skinPixels > 0 ? skinXSum / skinPixels : centerX
    const faceCenterY = skinPixels > 0 ? skinYSum / skinPixels : centerY
    const offsetX = Math.abs(faceCenterX - centerX) / (w / 2)
    const offsetY = Math.abs(faceCenterY - centerY) / (h / 2)

    if (offsetX > 0.35 || offsetY > 0.35) {
      setValidation('Center your face in the circle', 'warning', true)
      return
    }

    if (skinRatio < 0.05) {
      setValidation('Move closer to the camera', 'warning', true)
      return
    }

    setCanRecord(true)

    const totalSideSkin = leftSkinPixels + rightSkinPixels
    if (totalSideSkin > 0) {
      const asymmetry = Math.abs(leftSkinPixels - rightSkinPixels) / totalSideSkin
      if (asymmetry > 0.4) {
        setValidation(`Look into the camera so ${ceoName} can read your expression`, 'warning', false)
        return
      }
    }

    if (avgBrightness < 70) {
      setValidation('A bit more light would help', 'warning', false)
      return
    }

    setValidation('Ready to record', 'success', false)
  }

  async function startVideoPreview() {
    const stream = await requestVideoCaptureStream()
    await attachVideoPreviewStream(stream)

    setVideoStatusText('')
    setValidationText('Position your face in the circle')
    setValidationType('')

    stopFaceDetection()
    faceDetectionIntervalRef.current = window.setInterval(runFaceValidation, 500)
  }

  function stopVideoPreview() {
    stopFaceDetection()
    if (videoStreamRef.current) {
      videoStreamRef.current.getTracks().forEach((track) => track.stop())
      videoStreamRef.current = null
    }
    const preview = videoPreviewRef.current
    if (preview) {
      preview.pause()
      preview.srcObject = null
      preview.style.transform = ''
    }
  }

  function detectVideoRotation(blob: Blob): Promise<'landscape' | 'quicktime_portrait' | 'portrait' | 'unknown'> {
    return new Promise((resolve) => {
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.preload = 'auto'

      const blobUrl = URL.createObjectURL(blob)
      video.src = blobUrl

      const cleanup = () => {
        URL.revokeObjectURL(blobUrl)
        video.remove()
      }

      video.onloadeddata = () => {
        const vw = video.videoWidth
        const vh = video.videoHeight
        console.log('[RotationDetect] videoWidth:', vw, 'videoHeight:', vh)

        const isQuicktime =
          blob.type === 'video/quicktime' ||
          (blob instanceof File && ((blob.name || '').toLowerCase().endsWith('.mov')))

        if (vw > vh) {
          console.log('[RotationDetect] Landscape frames detected, needs rotation')
          cleanup()
          resolve('landscape')
        } else if (isQuicktime) {
          console.log('[RotationDetect] QuickTime/MOV from iPhone, re-encoding to bake rotation')
          cleanup()
          resolve('quicktime_portrait')
        } else {
          console.log('[RotationDetect] Already portrait, no correction needed')
          cleanup()
          resolve('portrait')
        }
      }

      video.onerror = () => {
        cleanup()
        resolve('unknown')
      }

      window.setTimeout(() => {
        cleanup()
        resolve('unknown')
      }, 5000)
    })
  }

  function correctVideoOrientation(blob: Blob, force = false): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const testVideo = document.createElement('video')
      testVideo.muted = true
      testVideo.playsInline = true
      testVideo.preload = 'metadata'

      const blobUrl = URL.createObjectURL(blob)
      testVideo.src = blobUrl

      testVideo.onloadedmetadata = () => {
        const vw = testVideo.videoWidth
        const vh = testVideo.videoHeight
        console.log('[VideoRotation] Raw dimensions:', vw, 'x', vh, 'force:', force)

        if (vw <= vh && !force) {
          URL.revokeObjectURL(blobUrl)
          testVideo.remove()
          console.log('[VideoRotation] Already portrait, no correction needed')
          resolve(blob)
          return
        }

        const needsRotation = vw > vh
        console.log(
          '[VideoRotation]',
          needsRotation
            ? 'Landscape detected, re-encoding with 90° CW rotation'
            : 'Forced re-encode to bake in rotation metadata'
        )

        const canvas = document.createElement('canvas')
        if (needsRotation) {
          canvas.width = vh
          canvas.height = vw
        } else {
          canvas.width = vw
          canvas.height = vh
        }
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          URL.revokeObjectURL(blobUrl)
          reject(new Error('Failed to create canvas context'))
          return
        }

        const canvasStream = canvas.captureStream(30)
        const mimeType = pickVideoMimeType()

        const origVideo = document.createElement('video')
        origVideo.muted = false
        origVideo.playsInline = true
        origVideo.src = blobUrl

        origVideo.onloadedmetadata = () => {
          try {
            const captureCapableVideo = origVideo as HTMLVideoElement & {
              captureStream?: () => MediaStream
              mozCaptureStream?: () => MediaStream
            }
            const origStream = captureCapableVideo.captureStream
              ? captureCapableVideo.captureStream()
              : captureCapableVideo.mozCaptureStream
                ? captureCapableVideo.mozCaptureStream()
                : null
            const audioTracks = origStream ? origStream.getAudioTracks() : []
            if (audioTracks.length > 0) {
              audioTracks.forEach((track: MediaStreamTrack) => canvasStream.addTrack(track))
              console.log('[VideoRotation] Audio track attached')
            }
          } catch (error: any) {
            console.warn('[VideoRotation] Could not capture audio:', error.message)
          }

          const chunks: BlobPart[] = []
          const recorder = new MediaRecorder(canvasStream, mimeType ? { mimeType } : undefined)
          recorder.ondataavailable = (event) => {
            if (event.data.size > 0) chunks.push(event.data)
          }

          recorder.onstop = () => {
            URL.revokeObjectURL(blobUrl)
            testVideo.remove()
            origVideo.remove()
            canvas.remove()
            if (chunks.length === 0) {
              reject(new Error('No frames captured'))
              return
            }
            const correctedBlob = new Blob(chunks, { type: recorder.mimeType || mimeType || '' })
            console.log('[VideoRotation] Re-encoded blob size:', correctedBlob.size)
            resolve(correctedBlob)
          }

          recorder.start(100)
          origVideo.currentTime = 0
          origVideo.play().catch(() => {})

          const drawFrame = () => {
            if (origVideo.paused || origVideo.ended) {
              if (recorder.state === 'recording') recorder.stop()
              return
            }
            if (needsRotation) {
              ctx.save()
              ctx.translate(canvas.width / 2, canvas.height / 2)
              ctx.rotate(Math.PI / 2)
              ctx.drawImage(origVideo, -vw / 2, -vh / 2, vw, vh)
              ctx.restore()
            } else {
              ctx.drawImage(origVideo, 0, 0, canvas.width, canvas.height)
            }
            requestAnimationFrame(drawFrame)
          }

          origVideo.onplay = drawFrame
          origVideo.onended = () => {
            if (recorder.state === 'recording') recorder.stop()
          }
        }

        origVideo.onerror = () => {
          URL.revokeObjectURL(blobUrl)
          reject(new Error('Failed to load video for re-encoding'))
        }
      }

      testVideo.onerror = () => {
        URL.revokeObjectURL(blobUrl)
        reject(new Error('Failed to load video metadata'))
      }
    })
  }

  function enterVideoPreview(blob: Blob) {
    const preview = videoPreviewRef.current
    if (!preview) return

    const previewUrl = URL.createObjectURL(blob)
    preview.srcObject = null
    preview.setAttribute('playsinline', '')
    preview.setAttribute('webkit-playsinline', 'true')
    preview.removeAttribute('muted')
    preview.muted = false
    preview.playsInline = true
    preview.loop = false
    preview.src = previewUrl

    preview.play().catch(() => {
      preview.muted = true
      preview.play().then(() => {
        preview.addEventListener('click', () => { preview.muted = false }, { once: true })
      }).catch(() => undefined)
    })

    preview.addEventListener('loadedmetadata', applyPreviewVideoTransform, { once: true })
    preview.addEventListener('loadedmetadata', updatePreviewControls, { once: true })
    applyPreviewVideoTransform()
    updatePreviewControls()

    setPreviewMode(true)
    setVideoHint(`Preview ${formatDuration(pendingVideoDurationRef.current)} • play, scrub, send or cancel`)
    setValidationText('Preview — tap send or cancel')
    setValidationType('success')
  }

  async function startVideoRecording() {
    if (!videoStreamRef.current || recordingMode !== 'idle' || previewMode) return

    const audioTrackCount = await ensureVideoCaptureAudioTracks()
    if (audioTrackCount === 0) {
      setValidationText('Microphone access is required so the video includes audio')
      setValidationType('error')
      return
    }

    const mimeType = pickVideoMimeType()
    const recorder = mimeType
      ? new MediaRecorder(videoStreamRef.current, { mimeType })
      : new MediaRecorder(videoStreamRef.current)

    videoRecorderRef.current = recorder
    videoChunksRef.current = []
    setRecordingMode('recording')
    setRecordingSeconds(0)
    startTimeRef.current = Date.now()
    setVideoHint('Tap to stop')

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) videoChunksRef.current.push(event.data)
    }

    recorder.onstop = async () => {
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
      const progress = elapsed / VIDEO_MAX_SECONDS
      const offset = PROGRESS_RING_CIRCUMFERENCE * (1 - progress)
      setProgressRingOffset(Math.max(offset, 0))
      setTimeWarning(VIDEO_MAX_SECONDS - elapsed <= 30)

      if (elapsed >= VIDEO_MAX_SECONDS) {
        void stopVideoRecording()
      }
    }, 1000)
  }

  async function stopVideoRecording() {
    if (recordingMode !== 'recording') return

    setRecordingMode('stopping')
    if (timerRef.current) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    stopFaceDetection()

    const blobPromise = new Promise<Blob | null>((resolve) => {
      stopResolverRef.current = resolve
    })

    if (videoRecorderRef.current && videoRecorderRef.current.state !== 'inactive') {
      videoRecorderRef.current.stop()
    } else {
      stopResolverRef.current?.(null)
    }

    const rawBlob = await blobPromise
    setRecordingMode('idle')
    setRecordingSeconds(0)
    setTimeWarning(false)
    setProgressRingOffset(PROGRESS_RING_CIRCUMFERENCE)

    if (!rawBlob) return

    let finalBlob: Blob
    if (isIOSSafari && videoStreamIsLandscapeRef.current) {
      console.log('[VideoRotation] iOS Safari + landscape stream: skipping re-encode, using CSS rotation for preview')
      finalBlob = rawBlob
    } else {
      const correctedBlob = await correctVideoOrientation(rawBlob).catch((err) => {
        console.warn('[VideoRotation] Correction failed, using raw blob:', err?.message || err)
        return rawBlob
      })
      finalBlob = correctedBlob
    }
    videoBlobRef.current = finalBlob
    pendingVideoDurationRef.current = Math.max(1, Math.round((Date.now() - startTimeRef.current) / 1000))
    setPreviewDuration(pendingVideoDurationRef.current)
    enterVideoPreview(finalBlob)
  }

  function seekPreviewToRatio(ratio: number) {
    const preview = videoPreviewRef.current
    if (!preview) return
    const duration = getPreviewDurationSeconds()
    if (!duration) return
    const safeRatio = Math.max(0, Math.min(1, ratio))
    preview.currentTime = safeRatio * duration
    updatePreviewControls()
  }

  function togglePreviewPlayback() {
    const preview = videoPreviewRef.current
    if (!preview || !previewMode) return
    if (preview.paused || preview.ended) {
      if (preview.ended) preview.currentTime = 0
      preview.play().catch(() => undefined)
    } else {
      preview.pause()
    }
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
    const firstName = (conversation.wa_owners?.display_name || 'Avatar').split(' ')[0]
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

    if (!opmUrl) {
      console.log('[OPM] Mock mode - no OPM_API_URL')
      onStage('\uD83D\uDCE1', uploadLabel, 10)

      const submitRes = await fetch('/api/perception', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: conversation.contact_id || conversation.id }),
      })
      const submitData = await submitRes.json().catch(() => ({}))
      if (submitData.error) throw new Error(submitData.error)

      onStage('\uD83D\uDD2C', watchingLabel, 40)
      await delay(1200)
      onStage('\uD83E\uDDE0', `${firstName} is reading your expressions...`, 70)
      await delay(1000)
      onStage('\uD83D\uDCAC', `${firstName} is composing a response...`, 95)
      await delay(600)

      const resultsRes = await fetch(`/api/perception?action=results&job_id=${submitData.job_id}`)
      const mockResults = await resultsRes.json().catch(() => ({}))
      return normalizeOpmResponse(mockResults)
    }

    const useProxy = !!opts.orientation
    const uploadUrl = useProxy ? '/api/ingest-video' : `${opmUrl}/analyze`
    console.log(
      '[OPM]',
      useProxy ? 'Proxy upload via /api/ingest-video' : 'Direct upload to OPM',
      'url:',
      uploadUrl,
      'mediaType:',
      mediaType,
      'preset:',
      preset
    )
    onStage('\uD83D\uDCE1', uploadLabel, 10)

    const formData = new FormData()
    formData.append('video', mediaBlob, fileName)
    formData.append('user_id', conversation.contact_id || conversation.id || '')
    formData.append('preset', preset)
    if (conversation.wa_contacts?.display_name) {
      formData.append('contact_name', conversation.wa_contacts.display_name)
    }
    if (opts.orientation) {
      formData.append('orientation', String(opts.orientation))
      console.log('[OPM] Sending orientation metadata:', opts.orientation)
    }

    console.log('[OPM] Uploading, size:', mediaBlob.size, 'type:', mediaBlob.type)
    const submitRes = await fetch(uploadUrl, { method: 'POST', body: formData })
    if (!submitRes.ok) {
      const errData = await submitRes.json().catch(() => ({}))
      console.error('[OPM] Submit error:', submitRes.status, JSON.stringify(errData))
      throw new Error(errData.error || 'processing_error')
    }

    const submitData = await submitRes.json()
    const jobId = submitData.job_id
    console.log('[OPM] Job submitted, id:', jobId)

    onStage('\uD83D\uDD2C', watchingLabel, 25)
    const startTime = Date.now()
    let jobComplete = false

    while (Date.now() - startTime < OPM_CLIENT_TIMEOUT_MS) {
      await delay(OPM_CLIENT_POLL_INTERVAL_MS)
      const statusRes = await fetch(`${opmUrl}/status/${jobId}`)
      if (!statusRes.ok) {
        console.error('[OPM] Status poll HTTP error:', statusRes.status)
        continue
      }

      const statusData = await statusRes.json()
      console.log('[OPM] Polling status:', JSON.stringify(statusData))
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
      console.error('[OPM] Polling timed out after', Math.round((Date.now() - startTime) / 1000), 'seconds')
      throw new Error('processing_timeout')
    }

    onStage('\uD83D\uDCAC', `${firstName} is composing a response...`, 95)
    console.log('[OPM] Job complete, fetching results...')
    const resultsRes = await fetch(`${opmUrl}/results/${jobId}`)
    if (!resultsRes.ok) {
      console.error('[OPM] Results fetch error:', resultsRes.status)
      throw new Error('processing_error')
    }

    const rawResults = await resultsRes.json()
    console.log('[OPM] FULL RAW:', JSON.stringify(rawResults))
    if (rawResults.error) throw new Error(rawResults.error)
    const resultsData = normalizeOpmResponse(rawResults)
    console.log('[OPM] Normalized transcript:', resultsData.transcript)
    console.log('[OPM] Normalized interpretation:', JSON.stringify(resultsData.interpretation).substring(0, 200))
    console.log('[OPM] Normalized perception:', JSON.stringify(resultsData.perception).substring(0, 200))
    return resultsData
  }

  function getImmersiveError(errorType: string, ceoName: string) {
    const errors: Record<string, string> = {
      processing_timeout: `${ceoName} is in a meeting right now. They'll watch your video as soon as possible.`,
      api_down: `${ceoName} is currently unavailable. Try again in a moment.`,
      no_face_detected: `${ceoName} couldn't see your face clearly. Try recording again with better lighting.`,
      processing_error: `${ceoName} had trouble reading your message. Want to send it again?`,
      no_transcript: `${ceoName} watched your video but the audio was unclear. Responding based on what they could see.`,
      video_too_long: `That was a bit long! Keep it under 5 minutes so ${ceoName} can focus.`,
    }
    return errors[errorType] || `${ceoName} had trouble reading your message. Want to send it again?`
  }

  async function processVideoMessage(videoBlob: Blob, durationSeconds: number, opts: { orientation?: number } = {}) {
    if (!conversationId || !conversation) return

    const ceoName = conversation.wa_owners?.display_name || 'Avatar'
    const localBlobUrl = URL.createObjectURL(videoBlob)
    const tempId = `temp-video-${Date.now()}`
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
      isGalleryVideo: false,
      videoNeedsRotation: !!opts.orientation,
      videoRotationScale: Number(videoStreamRotationScaleRef.current) > 1 ? Number(videoStreamRotationScaleRef.current) : 1.35,
    }

    onMessageSent(optimisticMessage)
    onSending(true)
    onError(null)
    setProcessingStage({ emoji: '\uD83D\uDCE1', text: 'Uploading video...', progress: 10 })
    setProcessingMessageId(tempId)

    try {
      const [mediaUrl, opmResponse] = await Promise.all([
        uploadMediaToStorage(conversation, videoBlob as File, 'video'),
        callOpmApi(
          videoBlob,
          (emoji, text, progress) => setProcessingStage({ emoji, text, progress }),
          'video',
          opts
        ),
      ])

      if (!mediaUrl) throw new Error('upload failed')

      const transcript = opmResponse.transcript?.trim() || '[Video message]'
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
        videoNeedsRotation: !!opts.orientation,
        videoRotationScale: Number(videoStreamRotationScaleRef.current) > 1 ? Number(videoStreamRotationScaleRef.current) : 1.35,
      })
      setProcessingMessageId(String(message.id))
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
        personaName: conversation.wa_owners?.display_name ?? null,
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
    } catch (error: any) {
      console.error('[Video] processVideoMessage failed:', error?.message, error?.stack)
      onMessageUpdate(tempId, {
        _pending: false,
        _failed: true,
        _errorMessage: getImmersiveError(error?.message || 'processing_error', ceoName),
        _retryFn: () => void processVideoMessage(videoBlob, durationSeconds, opts),
      })
    } finally {
      onSending(false)
      setProcessingStage(null)
      setProcessingMessageId(null)
    }
  }

  async function sendVideoBlob() {
    if (!conversationId || !conversation || !videoBlobRef.current) return

    const blob = videoBlobRef.current
    const durationSeconds = pendingVideoDurationRef.current || previewDuration || Math.max(1, recordingSeconds)
    let opmOpts: { orientation?: number } = {}

    const rotation = await detectVideoRotation(blob)
    if (rotation === 'landscape') opmOpts = { orientation: 90 }
    else if (rotation === 'quicktime_portrait') opmOpts = { orientation: 90 }

    await processVideoMessage(blob, durationSeconds, opmOpts)
    closeVideoOverlay()
  }

  async function openVideoOverlay() {
    setVideoOverlayOpen(true)
    setRecordingMode('idle')
    setRecordingSeconds(0)
    setProgressRingOffset(PROGRESS_RING_CIRCUMFERENCE)
    setTimeWarning(false)
    setVideoHint('Tap to record')
    setVideoStatusText('Preparing camera...')
    setValidationText('Position your face in the circle')
    setValidationType('')
    setCanRecord(false)
    setPreviewMode(false)
    setPreviewDuration(0)
    setPreviewCurrentTime(0)
    setPreviewProgress(0)
    setPreviewPlaying(false)
    manualRotationDegreesRef.current = 0
    videoBlobRef.current = null

    try {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve())
      })
      await startVideoPreview()
    } catch (error) {
      console.error(error)
      setVideoOverlayOpen(false)
      onError('Camera access required for video messages')
    }
  }

  function closeVideoOverlay() {
    if (timerRef.current) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    stopFaceDetection()
    if (videoRecorderRef.current && videoRecorderRef.current.state !== 'inactive') {
      videoRecorderRef.current.stop()
    }
    stopVideoPreview()

    const preview = videoPreviewRef.current
    if (preview) {
      preview.pause()
      preview.src = ''
      preview.srcObject = null
      preview.style.transform = ''
    }

    setVideoOverlayOpen(false)
    setRecordingMode('idle')
    setPreviewMode(false)
    setRecordingSeconds(0)
    setPreviewDuration(0)
    setPreviewCurrentTime(0)
    setPreviewProgress(0)
    setPreviewPlaying(false)
    setCanRecord(false)
    setTimeWarning(false)
    setProgressRingOffset(PROGRESS_RING_CIRCUMFERENCE)
    setVideoStatusText('Preparing camera...')
    setValidationText('Position your face in the circle')
    setValidationType('')
    setVideoHint('Tap to record')
    pendingVideoDurationRef.current = 0
    videoBlobRef.current = null
  }

  async function retakeVideo() {
    pendingVideoDurationRef.current = 0
    setPreviewMode(false)
    setPreviewDuration(0)
    setPreviewCurrentTime(0)
    setPreviewProgress(0)
    setPreviewPlaying(false)
    videoBlobRef.current = null
    const preview = videoPreviewRef.current
    if (preview) {
      preview.pause()
      preview.src = ''
      preview.srcObject = null
      preview.style.transform = ''
    }
    await startVideoPreview()
  }

  function rotatePreview() {
    manualRotationDegreesRef.current = (manualRotationDegreesRef.current + 90) % 360
    applyPreviewVideoTransform()
    setValidationText(
      manualRotationDegreesRef.current
        ? `Rotated ${manualRotationDegreesRef.current}° — tap send or cancel`
        : 'Preview — tap send or cancel'
    )
    setValidationType('success')
  }

  useEffect(() => {
    const preview = videoPreviewRef.current
    if (!preview) return

    const onLoadedData = () => {
      if (preview.currentTime === 0) preview.currentTime = 0.001
      updatePreviewControls()
    }
    const onPlay = () => setPreviewPlaying(true)
    const onPause = () => setPreviewPlaying(false)
    const onTimeUpdate = () => updatePreviewControls()
    const onDurationChange = () => updatePreviewControls()
    const onEnded = () => {
      setPreviewPlaying(false)
      updatePreviewControls()
    }

    preview.addEventListener('loadeddata', onLoadedData)
    preview.addEventListener('play', onPlay)
    preview.addEventListener('pause', onPause)
    preview.addEventListener('timeupdate', onTimeUpdate)
    preview.addEventListener('durationchange', onDurationChange)
    preview.addEventListener('ended', onEnded)

    return () => {
      preview.removeEventListener('loadeddata', onLoadedData)
      preview.removeEventListener('play', onPlay)
      preview.removeEventListener('pause', onPause)
      preview.removeEventListener('timeupdate', onTimeUpdate)
      preview.removeEventListener('durationchange', onDurationChange)
      preview.removeEventListener('ended', onEnded)
    }
  }, [videoOverlayOpen, previewMode])

  useEffect(() => () => {
    closeVideoOverlay()
  }, [])

  return {
    videoOverlayOpen,
    recordingMode,
    recordingSeconds,
    progressRingOffset,
    timeWarning,
    videoHint,
    videoStatusText,
    validationText,
    validationType,
    canRecord,
    previewMode,
    previewDuration,
    previewCurrentTime,
    previewProgress,
    previewPlaying,
    processingStage,
    processingMessageId,
    videoPreviewRef,
    pickVideoMimeType,
    startVideoPreview,
    startVideoRecording,
    stopVideoRecording,
    enterVideoPreview,
    correctVideoOrientation,
    callOpmApi,
    seekPreviewToRatio,
    togglePreviewPlayback,
    openVideoOverlay,
    closeVideoOverlay,
    retakeVideo,
    rotatePreview,
    sendVideoBlob,
  }
}
