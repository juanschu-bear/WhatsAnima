type TrackGetter = () => MediaStreamTrack | null

export type LocalCallRecorderOptions = {
  getRemoteVideoTrack: TrackGetter
  getRemoteAudioTrack: TrackGetter
  getLocalVideoTrack: TrackGetter
  getLocalAudioTrack: TrackGetter
  filenameHint?: string
}

export type LocalCallRecorderResult = {
  blob: Blob
  url: string
  filename: string
  mimeType: string
  durationMs: number
}

function pickMimeType(): { mimeType: string; extension: string } {
  if (typeof MediaRecorder === 'undefined') return { mimeType: '', extension: 'webm' }
  const candidates: Array<{ mimeType: string; extension: string }> = [
    { mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', extension: 'mp4' },
    { mimeType: 'video/mp4', extension: 'mp4' },
    { mimeType: 'video/webm;codecs=vp9,opus', extension: 'webm' },
    { mimeType: 'video/webm;codecs=vp8,opus', extension: 'webm' },
    { mimeType: 'video/webm', extension: 'webm' },
  ]
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c.mimeType)) return c
    } catch {}
  }
  return { mimeType: '', extension: 'webm' }
}

function buildFilename(hint: string | undefined, extension: string) {
  const safeHint = (hint || 'call').replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 60) || 'call'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${safeHint}-${stamp}.${extension}`
}

export class LocalCallRecorder {
  private opts: LocalCallRecorderOptions
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private remoteVideoEl: HTMLVideoElement | null = null
  private localVideoEl: HTMLVideoElement | null = null
  private animationFrame: number | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private audioContext: AudioContext | null = null
  private startedAt = 0
  private active = false
  private mimeType = ''
  private extension = 'webm'

  constructor(opts: LocalCallRecorderOptions) {
    this.opts = opts
  }

  isActive() {
    return this.active
  }

  async start(): Promise<void> {
    if (this.active) return
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('Recording not supported in this browser')
    }

    const remoteVideo = this.opts.getRemoteVideoTrack()
    const localVideo = this.opts.getLocalVideoTrack()
    if (!remoteVideo && !localVideo) {
      throw new Error('No video tracks available to record yet')
    }

    const width = 1280
    const height = 720
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context unavailable')
    this.canvas = canvas
    this.ctx = ctx

    const attachVideo = (track: MediaStreamTrack | null) => {
      if (!track) return null
      const el = document.createElement('video')
      el.autoplay = true
      el.muted = true
      el.playsInline = true
      el.srcObject = new MediaStream([track])
      void el.play().catch(() => undefined)
      return el
    }
    this.remoteVideoEl = attachVideo(remoteVideo)
    this.localVideoEl = attachVideo(localVideo)

    const drawFrame = () => {
      if (!this.ctx || !this.canvas) return
      this.ctx.fillStyle = '#000'
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)

      const remote = this.remoteVideoEl
      const local = this.localVideoEl

      if (remote && remote.videoWidth > 0) {
        this.drawCover(remote, 0, 0, this.canvas.width, this.canvas.height)
      } else if (local && local.videoWidth > 0) {
        this.drawCover(local, 0, 0, this.canvas.width, this.canvas.height)
      }

      if (remote && local && local.videoWidth > 0) {
        const pipW = Math.floor(this.canvas.width * 0.22)
        const pipH = Math.floor(pipW * (local.videoHeight / local.videoWidth || 0.5625))
        const margin = 24
        const x = this.canvas.width - pipW - margin
        const y = this.canvas.height - pipH - margin
        this.ctx.save()
        this.ctx.shadowColor = 'rgba(0,0,0,0.45)'
        this.ctx.shadowBlur = 18
        this.drawCover(local, x, y, pipW, pipH)
        this.ctx.restore()
      }

      this.animationFrame = requestAnimationFrame(drawFrame)
    }
    this.animationFrame = requestAnimationFrame(drawFrame)

    const canvasStream = canvas.captureStream(30)

    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
    const destination = audioContext.createMediaStreamDestination()
    this.audioContext = audioContext

    const remoteAudio = this.opts.getRemoteAudioTrack()
    const localAudio = this.opts.getLocalAudioTrack()
    const addAudio = (track: MediaStreamTrack | null) => {
      if (!track) return
      const source = audioContext.createMediaStreamSource(new MediaStream([track]))
      source.connect(destination)
    }
    addAudio(remoteAudio)
    addAudio(localAudio)

    const combined = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...destination.stream.getAudioTracks(),
    ])

    const { mimeType, extension } = pickMimeType()
    this.mimeType = mimeType
    this.extension = extension

    const recorder = mimeType
      ? new MediaRecorder(combined, { mimeType, videoBitsPerSecond: 2_500_000 })
      : new MediaRecorder(combined, { videoBitsPerSecond: 2_500_000 })

    this.chunks = []
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data)
    }
    recorder.start(1000)
    this.recorder = recorder
    this.startedAt = Date.now()
    this.active = true
  }

  private drawCover(video: HTMLVideoElement, x: number, y: number, w: number, h: number) {
    if (!this.ctx) return
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!vw || !vh) return
    const targetRatio = w / h
    const sourceRatio = vw / vh
    let sx = 0
    let sy = 0
    let sw = vw
    let sh = vh
    if (sourceRatio > targetRatio) {
      sw = vh * targetRatio
      sx = (vw - sw) / 2
    } else {
      sh = vw / targetRatio
      sy = (vh - sh) / 2
    }
    this.ctx.drawImage(video, sx, sy, sw, sh, x, y, w, h)
  }

  async stop(): Promise<LocalCallRecorderResult> {
    if (!this.active || !this.recorder) {
      throw new Error('Recorder is not active')
    }
    const recorder = this.recorder
    const finalize = new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => resolve(), { once: true })
    })
    if (recorder.state !== 'inactive') recorder.stop()
    await finalize

    const durationMs = Date.now() - this.startedAt
    const blobType = this.mimeType.split(';')[0] || (this.extension === 'mp4' ? 'video/mp4' : 'video/webm')
    const blob = new Blob(this.chunks, { type: blobType })
    const url = URL.createObjectURL(blob)
    const filename = buildFilename(this.opts.filenameHint, this.extension)

    this.cleanup()

    return { blob, url, filename, mimeType: blobType, durationMs }
  }

  cleanup() {
    this.active = false
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame)
      this.animationFrame = null
    }
    if (this.audioContext) {
      void this.audioContext.close().catch(() => undefined)
      this.audioContext = null
    }
    if (this.remoteVideoEl) {
      this.remoteVideoEl.srcObject = null
      this.remoteVideoEl = null
    }
    if (this.localVideoEl) {
      this.localVideoEl.srcObject = null
      this.localVideoEl = null
    }
    this.canvas = null
    this.ctx = null
    this.recorder = null
  }
}

export function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    a.remove()
  }, 0)
}
