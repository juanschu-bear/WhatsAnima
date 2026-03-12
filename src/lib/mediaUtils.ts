export function getFileExtension(file: Blob & { name?: string; type: string }, fallback: string) {
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

export function blobToBase64(blob: Blob) {
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

export function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

interface ConversationRef {
  id: string
  owner_id: string
  contact_id: string
}

export async function uploadAudioToStorage(conversation: ConversationRef, audioBase64: string, mimeType: string) {
  const cleanType = (mimeType || 'audio/webm').split(';')[0]
  const ext = cleanType === 'audio/mpeg' ? 'mp3' : cleanType === 'audio/mp4' ? 'm4a' : 'webm'
  const filename = `voice-${Date.now()}.${ext}`

  const response = await fetch('/api/upload-audio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audio: audioBase64,
      conversationId: conversation.id,
      filename,
    }),
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const msg = data?.error || `Upload failed (HTTP ${response.status})`
    console.error('[uploadAudio] FAILED:', msg)
    throw new Error(msg)
  }
  if (typeof data.url !== 'string') {
    throw new Error('Upload returned no URL')
  }
  return data.url
}

export async function uploadMediaToStorage(
  conversation: ConversationRef,
  file: File,
  mediaType: 'image' | 'video',
  isRecorded = false
) {
  const mediaBase64 = await blobToBase64(file)
  const ext = file.name?.split('.').pop() || (mediaType === 'image' ? 'jpg' : 'webm')
  const rawType = (file.type || '').split(';')[0] || (mediaType === 'image' ? 'image/jpeg' : 'video/webm')
  const filename = `${mediaType}-${Date.now()}.${ext}`

  const bucket = mediaType === 'image'
    ? 'image-uploads'
    : isRecorded
      ? 'video-messages'
      : 'video-uploads'

  const response = await fetch('/api/upload-media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      media: mediaBase64,
      conversationId: conversation.id,
      filename,
      contentType: rawType,
      mediaType,
      bucket,
    }),
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const msg = data?.error || `Media upload failed (HTTP ${response.status})`
    console.error('[uploadMedia] FAILED:', msg)
    throw new Error(msg)
  }
  if (typeof data.url !== 'string') {
    throw new Error('Media upload returned no URL')
  }
  return data.url
}

export async function getOpmConfig() {
  const response = await fetch('/api/config')
  const data = await response.json().catch(() => ({}))
  return {
    opm_api_url: typeof data.opm_api_url === 'string' ? data.opm_api_url : null,
    opm_preset: typeof data.opm_preset === 'string' ? data.opm_preset : 'celebrity_ceo',
  }
}

export function normalizeOpmResponse(raw: any) {
  const unwrapped = raw?.result || raw?.data || raw
  const echoAnalysis = unwrapped?.echo_analysis || null
  const standardAnalysis = unwrapped?.standard_analysis || null

  if (echoAnalysis || standardAnalysis) {
    const isEcho = !!echoAnalysis
    const analysis = echoAnalysis || standardAnalysis
    const audioFeatures = analysis.audio_features || {}
    const firedRules = analysis.fired_rules || []
    const transcript = audioFeatures.transcript || analysis.transcript || ''
    const sessionObj = unwrapped.session || null
    const lucidText =
      sessionObj?.lucid_interpretation?.interpretation ||
      sessionObj?.session_interpretation?.interpretation ||
      ''
    const sessionPatterns = sessionObj?.session_analysis?.session_patterns || []

    return {
      transcript,
      perception: {
        primary_emotion: audioFeatures.primary_emotion || null,
        secondary_emotion: audioFeatures.secondary_emotion || null,
        valence: audioFeatures.valence ?? null,
        arousal: audioFeatures.arousal ?? null,
        confidence: audioFeatures.confidence ?? null,
        behavioral_summary: lucidText || null,
        session_patterns: sessionPatterns,
        transcript,
      },
      interpretation: {
        behavioral_summary: lucidText || '',
        conversation_hooks: sessionPatterns.map((pattern: any) =>
          typeof pattern === 'string' ? pattern : pattern?.pattern || pattern?.description || JSON.stringify(pattern)
        ),
        lucid_raw: Boolean(lucidText),
      },
      session: sessionObj,
      analysisType: isEcho ? 'echo' : 'standard',
      duration_sec: analysis.duration_sec || null,
      processing_ms: analysis.processing_ms || null,
      skipped_reason: analysis.skipped_reason || null,
      prosodic_summary: audioFeatures.prosodic_summary || null,
      fired_rules: firedRules,
    }
  }

  return {
    transcript: unwrapped?.transcript || '',
    perception: unwrapped?.perception || {},
    interpretation: unwrapped?.interpretation || {},
    session: unwrapped?.session || null,
    analysisType: 'legacy',
    fired_rules: [],
  }
}

export type OpmStageCallback = (emoji: string, text: string, progress: number) => void

export async function callOpmApi(
  conversation: ConversationRef,
  mediaBlob: Blob,
  mediaType: 'audio' | 'video',
  opts?: { orientation?: number; onStage?: OpmStageCallback; avatarFirstName?: string }
) {
  const config = await getOpmConfig()
  const opmUrl = config.opm_api_url
  const preset = mediaType === 'audio' ? 'echo' : config.opm_preset || 'celebrity_ceo'
  const blobType = (mediaBlob.type || '').toLowerCase()
  let ext = 'webm'
  if (blobType.includes('aac')) ext = 'aac'
  else if (blobType.includes('m4a')) ext = 'm4a'
  else if (blobType.includes('mp4')) ext = 'mp4'
  else if (blobType.includes('ogg')) ext = 'ogg'
  const fileName = `capture.${ext}`

  const onStage = opts?.onStage || (() => {})
  const firstName = opts?.avatarFirstName || 'Avatar'
  const isAudio = mediaType === 'audio'
  const uploadLabel = isAudio ? 'Uploading voice...' : 'Uploading video...'
  const watchingLabel = isAudio
    ? `${firstName} is listening...`
    : `${firstName} is watching your message...`

  if (!opmUrl) {
    onStage('\uD83D\uDCE1', uploadLabel, 10)
    const audioBase64 = await blobToBase64(mediaBlob)
    const opmRes = await fetch('/api/opm-process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio: audioBase64,
        conversationId: conversation.id,
        contactId: conversation.contact_id,
        ownerId: conversation.owner_id,
        filename: fileName,
        contentType: mediaBlob.type || 'audio/webm',
      }),
    })
    onStage('\uD83D\uDD2C', watchingLabel, 40)
    const opmJson = await opmRes.json().catch(() => ({}))
    if (!opmRes.ok) {
      console.warn('[callOpmApi] opm-process error:', opmJson.error)
      return normalizeOpmResponse({})
    }
    onStage('\uD83E\uDDE0', `${firstName} is reading your expressions...`, 70)
    onStage('\uD83D\uDCAC', `${firstName} is composing a response...`, 95)
    return normalizeOpmResponse(opmJson.data || opmJson)
  }

  // Real OPM: upload directly or via proxy
  const useProxy = mediaType === 'video' && Boolean(opts?.orientation)
  const uploadUrl = useProxy ? '/api/ingest-video' : `${opmUrl}/analyze`
  onStage('\uD83D\uDCE1', uploadLabel, 10)
  const formData = new FormData()
  formData.append('video', mediaBlob, fileName)
  formData.append('session_id', conversation.id || '')
  formData.append('preset', preset)
  if (opts?.orientation) formData.append('orientation', String(opts.orientation))

  const submitRes = await fetch(uploadUrl, {
    method: 'POST',
    body: formData,
  })

  if (!submitRes.ok) {
    const errData = await submitRes.json().catch(() => ({}))
    throw new Error(errData.error || 'processing_error')
  }

  const submitData = await submitRes.json()
  const jobId = submitData.job_id
  const startTime = Date.now()
  let jobComplete = false

  onStage('\uD83D\uDD2C', watchingLabel, 25)

  while (Date.now() - startTime < 180000) {
    await delay(3000)
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

    // Map OPM stages to user-facing text
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
      const progress = Math.min(25 + Math.floor((elapsed / 180000) * 60), 85)
      onStage('\uD83D\uDD2C', watchingLabel, progress)
    }
  }

  if (!jobComplete) {
    throw new Error('processing_timeout')
  }

  onStage('\uD83D\uDCAC', `${firstName} is composing a response...`, 95)
  const resultsRes = await fetch(`${opmUrl}/results/${jobId}`)
  if (!resultsRes.ok) {
    throw new Error('processing_error')
  }

  const rawResults = await resultsRes.json()
  return normalizeOpmResponse(rawResults)
}

export async function transcribeServerSide(audioBase64: string, contentType: string, _locale?: string): Promise<string> {
  try {
    // Language auto-detected by ElevenLabs Scribe v1 — no forced language hint.
    // Forcing a wrong locale (e.g. 'eng' when user speaks German) caused misdetection.
    const response = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio: audioBase64,
        contentType,
      }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      console.warn('[transcribe] Server STT failed:', data.error)
      return ''
    }
    return (data.transcript || '').trim()
  } catch (err) {
    console.warn('[transcribe] Request failed:', err)
    return ''
  }
}

export async function readVideoMetadata(file: File) {
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

export async function correctVideoOrientation(file: File) {
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
