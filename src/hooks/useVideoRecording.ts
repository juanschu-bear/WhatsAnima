import { useEffect, useRef, useState } from 'react'

type GuidanceTone = 'neutral' | 'warning' | 'success' | 'error'

interface ConfirmPayload {
  blob: Blob
  durationSec: number
  orientation: 'portrait' | 'landscape'
  width: number
  height: number
}

interface UseVideoRecordingOptions {
  maxDurationSec?: number
  onConfirmSend?: (payload: ConfirmPayload) => Promise<void> | void
}

async function getVideoMetadata(source: Blob) {
  return new Promise<{ width: number; height: number; duration: number }>((resolve) => {
    const video = document.createElement('video')
    const url = URL.createObjectURL(source)
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      resolve({
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
      })
      URL.revokeObjectURL(url)
    }
    video.onerror = () => {
      resolve({ width: 0, height: 0, duration: 0 })
      URL.revokeObjectURL(url)
    }
    video.src = url
  })
}

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return ''
  const options = [
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
    '',
  ]
  return options.find((option) => option === '' || MediaRecorder.isTypeSupported(option)) || ''
}

export function useVideoRecording({ maxDurationSec = 300, onConfirmSend }: UseVideoRecordingOptions = {}) {
  const [isRecording, setIsRecording] = useState(false)
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [guidanceText, setGuidanceText] = useState('Hold steady')
  const [guidanceTone, setGuidanceTone] = useState<GuidanceTone>('neutral')
  const [cameraReady, setCameraReady] = useState(false)
  const [permissionPending, setPermissionPending] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [videoDimensions, setVideoDimensions] = useState({ width: 0, height: 0 })

  const liveVideoRef = useRef<HTMLVideoElement | null>(null)
  const previewVideoRef = useRef<HTMLVideoElement | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const mimeTypeRef = useRef('')
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<number | null>(null)
  const startedAtRef = useRef(0)
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const guidanceIntervalRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
      if (guidanceIntervalRef.current) window.clearInterval(guidanceIntervalRef.current)
      recorderRef.current?.stream.getTracks().forEach((track) => track.stop())
      stream?.getTracks().forEach((track) => track.stop())
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl, stream])

  function clearIntervals() {
    if (timerRef.current) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (guidanceIntervalRef.current) {
      window.clearInterval(guidanceIntervalRef.current)
      guidanceIntervalRef.current = null
    }
  }

  function stopTracks() {
    setStream((current) => {
      current?.getTracks().forEach((track) => track.stop())
      return null
    })
  }

  async function runGuidanceCheck() {
    const video = liveVideoRef.current
    if (!video || !stream || isPreviewing) return
    if (!video.videoWidth || !video.videoHeight) return

    if (!analysisCanvasRef.current) {
      analysisCanvasRef.current = document.createElement('canvas')
    }
    const canvas = analysisCanvasRef.current
    canvas.width = 160
    canvas.height = 160
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return

    ctx.drawImage(video, 0, 0, 160, 160)
    const image = ctx.getImageData(0, 0, 160, 160)
    let brightness = 0
    for (let index = 0; index < image.data.length; index += 16) {
      brightness += (image.data[index] + image.data[index + 1] + image.data[index + 2]) / 3
    }
    const averageBrightness = brightness / (image.data.length / 16)

    if (averageBrightness < 42) {
      setGuidanceText('More light needed')
      setGuidanceTone('warning')
      return
    }

    setGuidanceText('Hold steady')
    setGuidanceTone('success')
  }

  async function startCamera() {
    try {
      setPermissionPending(true)
      setError(null)

      const preferred = {
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: true,
      } as MediaStreamConstraints

      let mediaStream: MediaStream
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia(preferred)
      } catch {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: true,
        })
      }

      setStream(mediaStream)
      setIsPreviewing(false)
      setRecordedBlob(null)
      setDuration(0)
      setVideoDimensions({ width: 0, height: 0 })
      setCameraReady(false)
      setGuidanceText('Hold steady')
      setGuidanceTone('neutral')
      requestAnimationFrame(() => {
        if (liveVideoRef.current) {
          liveVideoRef.current.srcObject = mediaStream
          liveVideoRef.current.play().catch(() => undefined)
        }
      })
      setCameraReady(true)
      void runGuidanceCheck()
      guidanceIntervalRef.current = window.setInterval(() => {
        void runGuidanceCheck()
      }, 1000)
    } catch (cameraError) {
      console.error('[useVideoRecording] startCamera', cameraError)
      setError('Camera access is required to record video messages.')
    } finally {
      setPermissionPending(false)
    }
  }

  function startRecording() {
    if (!stream || permissionPending || isRecording) return
    try {
      const mimeType = pickMimeType()
      mimeTypeRef.current = mimeType
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      recorderRef.current = recorder
      chunksRef.current = []
      startedAtRef.current = Date.now()
      setError(null)
      setIsRecording(true)
      setDuration(0)

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = async () => {
        const blob = chunksRef.current.length
          ? new Blob(chunksRef.current, { type: recorder.mimeType || mimeTypeRef.current || 'video/mp4' })
          : null
        setIsRecording(false)
        if (!blob) return
        const metadata = await getVideoMetadata(blob)
        const nextPreviewUrl = URL.createObjectURL(blob)
        setVideoDimensions({ width: metadata.width, height: metadata.height })
        setDuration(Math.max(1, Math.round(metadata.duration || (Date.now() - startedAtRef.current) / 1000)))
        setRecordedBlob(blob)
        setPreviewUrl((current) => {
          if (current) URL.revokeObjectURL(current)
          return nextPreviewUrl
        })
        setIsPreviewing(true)
        stopTracks()
        clearIntervals()
      }

      recorder.start(250)
      timerRef.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000)
        setDuration(elapsed)
        if (elapsed >= maxDurationSec && recorder.state !== 'inactive') {
          recorder.stop()
        }
      }, 250)
    } catch (recordingError) {
      console.error('[useVideoRecording] startRecording', recordingError)
      setError('This browser cannot start video recording.')
    }
  }

  function stopRecording() {
    if (!recorderRef.current || recorderRef.current.state === 'inactive') return
    recorderRef.current.stop()
  }

  async function confirmSend() {
    if (!recordedBlob || !onConfirmSend) return
    try {
      setIsSending(true)
      const metadata = videoDimensions.width && videoDimensions.height
        ? { ...videoDimensions, duration }
        : await getVideoMetadata(recordedBlob)
      await onConfirmSend({
        blob: recordedBlob,
        durationSec: duration,
        orientation: metadata.height >= metadata.width ? 'portrait' : 'landscape',
        width: metadata.width,
        height: metadata.height,
      })
    } finally {
      setIsSending(false)
    }
  }

  function retake() {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(null)
    setRecordedBlob(null)
    setIsPreviewing(false)
    setDuration(0)
    setVideoDimensions({ width: 0, height: 0 })
    void startCamera()
  }

  function cancel() {
    clearIntervals()
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop()
    }
    stopTracks()
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(null)
    setRecordedBlob(null)
    setIsPreviewing(false)
    setIsRecording(false)
    setDuration(0)
    setVideoDimensions({ width: 0, height: 0 })
    setError(null)
    setCameraReady(false)
    setGuidanceText('Hold steady')
    setGuidanceTone('neutral')
  }

  return {
    isRecording,
    isPreviewing,
    recordedBlob,
    previewUrl,
    duration,
    error,
    stream,
    startCamera,
    startRecording,
    stopRecording,
    confirmSend,
    retake,
    cancel,
    liveVideoRef,
    previewVideoRef,
    guidanceText,
    guidanceTone,
    cameraReady,
    permissionPending,
    isSending,
    maxDurationSec,
    videoDimensions,
  }
}
