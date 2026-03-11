import { useRef, useState, type MutableRefObject } from 'react'
import { sendMessage } from '../lib/api'
import {
  getFileExtension,
  uploadMediaToStorage, callOpmApi,
} from '../lib/mediaUtils'

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
  shared: SharedRecordingState
  onSending: (sending: boolean) => void
  onError: (error: string | null) => void
  onMessageSent: (message: Message) => void
  onTranscript: (messageId: string, transcript: string) => void
  sendAvatarReply: (text: string, options?: { useVoice?: boolean; isVideo?: boolean; videoDurationSec?: number; perception?: any }) => Promise<void>
}

export function useVideoCapture({
  conversationId,
  conversation,
  shared,
  onSending,
  onError,
  onMessageSent,
  onTranscript,
  sendAvatarReply,
}: UseVideoCaptureOptions) {
  const {
    setRecordingMode, setCaptureKind, setRecordingSeconds,
    recordTimerRef, speechRecognitionRef, browserTranscriptRef, audioStartRef,
    stopRecordingTimer, startSpeechRecognition,
  } = shared

  // Video-specific state
  const [videoOverlayOpen, setVideoOverlayOpen] = useState(false)
  const [videoOverlayMode, setVideoOverlayMode] = useState<VideoOverlayMode>('live')
  const [videoPermissionPending, setVideoPermissionPending] = useState(false)
  const [videoValidationText, setVideoValidationText] = useState('Position your face in the circle')
  const [videoValidationTone, setVideoValidationTone] = useState<ValidationTone>('')
  const [videoCanRecord, setVideoCanRecord] = useState(false)
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null)
  const [videoDraftSeconds, setVideoDraftSeconds] = useState(0)

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

  async function startLiveVideoRecording() {
    if (!conversation || !videoStreamRef.current) return

    try {
      const mimeTypeOptions = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
      const mimeType = mimeTypeOptions.find((option) => MediaRecorder.isTypeSupported(option)) || ''
      const recorder = mimeType ? new MediaRecorder(videoStreamRef.current, { mimeType }) : new MediaRecorder(videoStreamRef.current)
      videoRecorderRef.current = recorder
      videoChunksRef.current = []
      browserTranscriptRef.current = ''

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
      recordTimerRef.current = window.setInterval(() => {
        setRecordingSeconds(Math.floor((Date.now() - audioStartRef.current) / 1000))
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

    if (!blob) return

    const videoTranscript = browserTranscriptRef.current.trim()
    browserTranscriptRef.current = ''

    const file = new File([blob], `recorded-video.${getFileExtension(blob, 'webm')}`, {
      type: blob.type || 'video/webm',
    })
    const duration = Math.max(1, Math.round((Date.now() - audioStartRef.current) / 1000))

    try {
      const previewUrl = URL.createObjectURL(file)
      videoDraftBlobRef.current = file
      videoDraftTranscriptRef.current = videoTranscript
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
      onError('Unable to prepare this recorded video.')
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
    videoDraftTranscriptRef.current = ''
    speechRecognitionRef.current?.stop?.()
    speechRecognitionRef.current = null
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
      const [mediaUrl, opmResponse] = await Promise.all([
        uploadMediaToStorage(conversation, file, 'video', true),
        callOpmApi(conversation, file, 'video').catch((error) => {
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

      if (transcript) {
        onTranscript(message.id, transcript)
      }

      closeVideoOverlay()
      await sendAvatarReply(transcript || 'a recorded video', {
        useVoice: false,
        isVideo: true,
        videoDurationSec: videoDraftSeconds,
        perception: opmResponse,
      })
    } catch (videoSendError) {
      console.error(videoSendError)
      onError('Unable to send this recorded video.')
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
  }
}
