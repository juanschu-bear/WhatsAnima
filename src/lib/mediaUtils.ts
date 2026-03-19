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
  wa_contacts?: { display_name?: string | null } | null
}

/**
 * Upload audio to Supabase Storage.
 * Tries direct browser upload first (bypasses Vercel 4.5MB limit).
 * Falls back to /api/upload-audio (uses service role key, bypasses RLS).
 */
export async function uploadAudioToStorage(conversation: ConversationRef, audioBlob: Blob, mimeType: string) {
  const cleanType = (mimeType || 'audio/webm').split(';')[0]
  const ext = getFileExtension(audioBlob as Blob & { name?: string; type: string }, cleanType === 'audio/mpeg' ? 'mp3' : cleanType === 'audio/mp4' ? 'm4a' : 'webm')
  const filename = `voice-${Date.now()}.${ext}`
  const storagePath = `${conversation.id}/${filename}`
  const bucket = 'voice-messages'

  // Try direct Supabase upload first (fastest, no serverless function)
  try {
    const { supabase } = await import('./supabase')
    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(storagePath, audioBlob, { contentType: cleanType, upsert: true })

    if (!error) {
      const storedPath = data?.path || storagePath
      const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(storedPath)
      return urlData.publicUrl
    }
    console.warn('[uploadAudio] Direct upload failed:', error.message, '— falling back to API route')
  } catch (directErr: any) {
    console.warn('[uploadAudio] Direct upload error:', directErr.message, '— falling back to API route')
  }

  // Fallback: upload via /api/upload-audio as FormData (no size limit, bypasses RLS)
  const formData = new FormData()
  formData.append('file', audioBlob, filename)
  formData.append('conversationId', conversation.id)
  formData.append('filename', storagePath)
  formData.append('mimeType', cleanType)
  formData.append('ownerId', conversation.owner_id)

  const res = await fetch('/api/upload-audio', {
    method: 'POST',
    body: formData,
  })
  const data = await res.json().catch(() => ({}))
  if (res.ok && data.url) return data.url
  throw new Error('Upload failed: ' + (data.error || `HTTP ${res.status}`))
}

export async function uploadMediaToStorage(
  conversation: ConversationRef,
  file: Blob & { name?: string; type: string },
  mediaType: 'image' | 'video' = 'image'
) {
  const preferredBucket = mediaType === 'image' ? 'image-uploads' : 'video-messages'
  const fallbackBucket = 'video-messages'
  const bucketsToTry =
    preferredBucket === fallbackBucket ? [preferredBucket] : [preferredBucket, fallbackBucket]

  const extMap: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
  }
  const ext = extMap[file.type] || (mediaType === 'video' ? 'mp4' : 'jpg')
  const rand = Math.random().toString(36).slice(2, 10)

  const { supabase } = await import('./supabase')
  for (const bucket of bucketsToTry) {
    const prefix = bucket === fallbackBucket && mediaType === 'image' ? 'images/' : ''
    const filePath = `${prefix}${conversation.owner_id}/${conversation.id}/${Date.now()}-${rand}.${ext}`

    console.log('[MediaUpload] SDK trying bucket:', bucket, 'path:', filePath, 'size:', file.size)
    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(filePath, file, { contentType: file.type, upsert: false })

    if (error) {
      console.warn('[MediaUpload] SDK upload failed on', bucket, ':', error.message)
      continue
    }

    const storedPath = data?.path || filePath
    const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(storedPath)
    console.log('[MediaUpload] SDK success on', bucket, ':', urlData.publicUrl)
    return urlData.publicUrl
  }

  console.warn('[MediaUpload] All SDK bucket attempts failed, trying API endpoint')
  const base64 = await blobToBase64(file)
  const res = await fetch('/api/upload-media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      media_base64: base64,
      user_id: conversation.owner_id,
      ceo_id: conversation.contact_id,
      mime_type: file.type,
      media_type: mediaType,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (data.url) {
    console.log('[MediaUpload] API success:', data.url)
    return data.url
  }
  console.warn('[MediaUpload] API failed:', data.error)
  return null
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
  const isPlaceholderSummary = (value: any) => {
    const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
    return text === '[no session patterns detected]' || text === 'no session patterns detected'
  }

  if (echoAnalysis || standardAnalysis) {
    const isEcho = !!echoAnalysis
    const analysis = echoAnalysis || standardAnalysis
    const audioFeatures = analysis.audio_features || {}
    const firedRules = analysis.fired_rules || []
    const transcript = audioFeatures.transcript || analysis.transcript || ''
    const sessionObj = unwrapped.session || null
    const directBehavioralSummaryRaw =
      analysis.behavioral_summary ||
      analysis.oracle_pulse?.behavioral_interpretation ||
      ''
    const directBehavioralSummary = isPlaceholderSummary(directBehavioralSummaryRaw) ? '' : directBehavioralSummaryRaw
    const sessionLucidRaw =
      sessionObj?.lucid_interpretation?.interpretation ||
      sessionObj?.session_interpretation?.interpretation ||
      ''
    const sessionLucid = isPlaceholderSummary(sessionLucidRaw) ? '' : sessionLucidRaw
    const lucidText = directBehavioralSummary || sessionLucid || ''
    const sessionPatterns = sessionObj?.session_analysis?.session_patterns || []
    console.log('[normalizeOpmResponse] behavioral_summary extraction', {
      analysisType: isEcho ? 'echo' : 'standard',
      directBehavioralSummaryRaw,
      directBehavioralSummary,
      sessionLucidRaw,
      sessionLucid,
      finalBehavioralSummary: lucidText || null,
      firedRulesCount: Array.isArray(firedRules) ? firedRules.length : 0,
    })

    return {
      transcript,
      behavioral_summary: lucidText || null,
      conversation_hooks: sessionPatterns.map((pattern: any) =>
        typeof pattern === 'string' ? pattern : pattern?.pattern || pattern?.description || JSON.stringify(pattern)
      ),
      recommended_tone: analysis.recommended_tone || sessionObj?.lucid_interpretation?.recommended_tone || null,
      perception: {
        primary_emotion: audioFeatures.primary_emotion || null,
        secondary_emotion: audioFeatures.secondary_emotion || null,
        valence: audioFeatures.valence ?? null,
        arousal: audioFeatures.arousal ?? null,
        confidence: audioFeatures.confidence ?? null,
        behavioral_summary: lucidText || null,
        recommended_tone: analysis.recommended_tone || sessionObj?.lucid_interpretation?.recommended_tone || null,
        session_patterns: sessionPatterns,
        transcript,
      },
      interpretation: {
        behavioral_summary: lucidText || '',
        conversation_hooks: sessionPatterns.map((pattern: any) =>
          typeof pattern === 'string' ? pattern : pattern?.pattern || pattern?.description || JSON.stringify(pattern)
        ),
        recommended_tone: analysis.recommended_tone || sessionObj?.lucid_interpretation?.recommended_tone || null,
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
const OPM_CLIENT_TIMEOUT_MS = 180000
const OPM_CLIENT_POLL_INTERVAL_MS = 3000
const OPM_AUDIO_TIMEOUT_MS = 300000

function hasMeaningfulOpmData(result: any) {
  if (!result) return false
  if (typeof result.transcript === 'string' && result.transcript.trim().length > 0) return true
  if (result.perception?.primary_emotion || result.perception?.secondary_emotion) return true
  if (result.behavioral_summary || result.interpretation?.behavioral_summary) return true
  if (Array.isArray(result.fired_rules) && result.fired_rules.length > 0) return true
  if (result.prosodic_summary && Object.keys(result.prosodic_summary).length > 0) return true
  return false
}

async function callOpmViaProxy(
  mediaBlob: Blob,
  fileName: string,
  conversation: ConversationRef,
  mediaType: 'audio' | 'video',
  onStage: OpmStageCallback,
  uploadLabel: string,
  watchingLabel: string,
  firstName: string,
) {
  onStage('\uD83D\uDCE1', uploadLabel, 10)
  const proxyForm = new FormData()
  proxyForm.append('file', mediaBlob, fileName)
  proxyForm.append('conversationId', conversation.id)
  proxyForm.append('contactId', conversation.contact_id || '')
  proxyForm.append('ownerId', conversation.owner_id || '')
  proxyForm.append('mediaType', mediaType)
  const opmRes = await fetch('/api/opm-process', {
    method: 'POST',
    body: proxyForm,
  })
  onStage('\uD83D\uDD2C', watchingLabel, 40)
  const opmJson = await opmRes.json().catch(() => ({}))
  if (!opmRes.ok) {
    console.warn('[callOpmApi] opm-process error:', opmJson.error)
    return normalizeOpmResponse({})
  }
  if (opmJson._debug) {
    console.log('[callOpmApi] server debug:', JSON.stringify(opmJson._debug))
  }
  if (!opmJson.data) {
    console.warn('[callOpmApi] opm-process returned null data — OPM error:', opmJson._debug?.opm_error || 'unknown', '| fallback:', opmJson._debug?.fallback || 'unknown')
  }
  onStage('\uD83E\uDDE0', `${firstName} is reading your expressions...`, 70)
  onStage('\uD83D\uDCAC', `${firstName} is composing a response...`, 95)
  return normalizeOpmResponse(opmJson.data || {})
}

export async function callOpmApi(
  conversation: ConversationRef,
  mediaBlob: Blob,
  mediaType: 'audio' | 'video',
  opts?: { orientation?: number | 'portrait' | 'landscape'; onStage?: OpmStageCallback; avatarFirstName?: string }
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
    return callOpmViaProxy(mediaBlob, fileName, conversation, mediaType, onStage, uploadLabel, watchingLabel, firstName)
  }

  try {
    // Real OPM: upload directly or via proxy
    const useProxy = mediaType === 'video' && typeof opts?.orientation === 'number'
    const uploadUrl = useProxy ? '/api/ingest-video' : `${opmUrl}/analyze`
    onStage('\uD83D\uDCE1', uploadLabel, 10)
    const formData = new FormData()
    formData.append('video', mediaBlob, fileName)
    formData.append('session_id', conversation.id || '')
    formData.append('preset', preset)
    if (conversation.wa_contacts?.display_name) formData.append('contact_name', conversation.wa_contacts.display_name)
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

    const timeoutMs = mediaType === 'audio' ? OPM_AUDIO_TIMEOUT_MS : OPM_CLIENT_TIMEOUT_MS

    while (Date.now() - startTime < timeoutMs) {
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
        const progress = Math.min(25 + Math.floor((elapsed / timeoutMs) * 60), 85)
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
    const normalized = normalizeOpmResponse(rawResults)
    if (mediaType === 'audio' && !hasMeaningfulOpmData(normalized)) {
      console.warn('[callOpmApi] direct audio OPM returned empty payload — falling back to proxy')
      return callOpmViaProxy(mediaBlob, fileName, conversation, mediaType, onStage, uploadLabel, watchingLabel, firstName)
    }
    return normalized
  } catch (error) {
    if (mediaType === 'audio') {
      console.warn('[callOpmApi] direct audio OPM failed — falling back to proxy', error)
      return callOpmViaProxy(mediaBlob, fileName, conversation, mediaType, onStage, uploadLabel, watchingLabel, firstName)
    }
    throw error
  }
}

/**
 * Transcribe audio server-side via ElevenLabs Scribe v1.
 * Accepts either a Blob (preferred, avoids Vercel 4.5MB body limit)
 * or a base64 string (legacy fallback).
 */
export async function transcribeServerSide(audioData: Blob | string, contentType: string, _locale?: string): Promise<string> {
  try {
    let response: Response
    if (audioData instanceof Blob) {
      // Send as FormData — no body size limit issues
      const formData = new FormData()
      const ext = contentType.includes('mp4') ? 'm4a' : contentType.includes('ogg') ? 'ogg' : 'webm'
      formData.append('file', audioData, `audio.${ext}`)
      response = await fetch('/api/transcribe', { method: 'POST', body: formData })
    } else {
      // Legacy base64 path
      response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: audioData, contentType }),
      })
    }
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
