export const config = {
  api: {
    bodyParser: false, // Handle raw body ourselves to support both JSON and FormData (avoids 4.5MB limit)
  },
}

/**
 * Parse incoming request body — supports both:
 * 1. FormData with 'file' field (preferred, avoids Vercel 4.5MB JSON body limit)
 * 2. JSON with 'audio' base64 string (legacy fallback for short clips)
 */
async function parseRequestBody(req: any): Promise<{ buffer: Buffer; contentType: string }> {
  const rawCt = req.headers['content-type'] || ''
  const ct = rawCt.toLowerCase()

  // Read raw body
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  const rawBody = Buffer.concat(chunks)

  if (ct.includes('multipart/form-data')) {
    // Parse multipart boundary from the ORIGINAL header (boundary is case-sensitive)
    const boundaryMatch = rawCt.match(/boundary=(.+?)(?:;|$)/)
    if (!boundaryMatch) throw new Error('No boundary in multipart request')
    const boundary = boundaryMatch[1]

    // Find the file part in the multipart body
    const delimiter = Buffer.from(`--${boundary}`)
    const headerSep = Buffer.from('\r\n\r\n')
    let pos = 0
    while (pos < rawBody.length) {
      const delimIdx = rawBody.indexOf(delimiter, pos)
      if (delimIdx === -1) break
      const partStart = delimIdx + delimiter.length + 2 // skip delimiter + \r\n
      const headerEndIdx = rawBody.indexOf(headerSep, partStart)
      if (headerEndIdx === -1) { pos = partStart; continue }
      const headers = rawBody.subarray(partStart, headerEndIdx).toString('utf-8')
      if (headers.includes('name="file"')) {
        const dataStart = headerEndIdx + headerSep.length
        // Find the next delimiter
        const nextDelim = rawBody.indexOf(delimiter, dataStart)
        const dataEnd = nextDelim !== -1 ? nextDelim - 2 : rawBody.length // -2 for \r\n before delimiter
        const partContentType = headers.match(/Content-Type:\s*(.+?)(?:\r\n|$)/i)?.[1]?.trim() || 'audio/webm'
        return { buffer: rawBody.subarray(dataStart, dataEnd), contentType: partContentType }
      }
      pos = partStart
    }
    throw new Error('No file field in FormData')
  }

  // JSON body
  const json = JSON.parse(rawBody.toString('utf-8'))
  if (!json.audio || typeof json.audio !== 'string') {
    throw new Error('audio (base64) is required')
  }
  return {
    buffer: Buffer.from(json.audio, 'base64'),
    contentType: json.contentType || 'audio/webm',
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Prefer Deepgram Nova-3 for STT (best multilingual code-switching: DE/EN/ES
  // natively supported with language=multi). Falls back to ElevenLabs Scribe.
  const deepgramKey = process.env.DEEPGRAM_API_KEY
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY || process.env.VITE_ELEVENLABS_API_KEY
  if (!deepgramKey && !elevenLabsKey) {
    return res.status(503).json({ error: 'Missing DEEPGRAM_API_KEY or ELEVENLABS_API_KEY' })
  }

  try {
    const { buffer, contentType } = await parseRequestBody(req)

    let transcript = ''
    let detectedLanguage: string | null = null

    if (deepgramKey) {
      // Deepgram Nova-3 with language=multi — native code-switching support
      // for DE/EN/ES in the same audio stream. Sends raw binary, not FormData.
      const dgContentType = contentType.includes('mp4') ? 'audio/mp4'
        : contentType.includes('ogg') ? 'audio/ogg'
        : contentType.includes('mpeg') ? 'audio/mpeg'
        : 'audio/webm'

      const response = await fetch(
        'https://api.deepgram.com/v1/listen?model=nova-3&language=multi&smart_format=true&detect_language=true',
        {
          method: 'POST',
          headers: {
            'Authorization': `Token ${deepgramKey}`,
            'Content-Type': dgContentType,
          },
          body: buffer,
        }
      )

      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        console.error('[transcribe] Deepgram STT error:', response.status, errText)
        return res.status(502).json({ error: `STT failed (${response.status})`, details: errText })
      }

      const data = await response.json()
      const alt = data.results?.channels?.[0]?.alternatives?.[0]
      transcript = (alt?.transcript || '').trim()
      detectedLanguage = data.results?.channels?.[0]?.detected_language || null
    } else {
      // Fallback: ElevenLabs Scribe v1
      const blob = new Blob([buffer], { type: contentType })
      const ext = contentType.includes('mp4') ? 'm4a'
        : contentType.includes('ogg') ? 'ogg'
        : 'webm'
      const formData = new FormData()
      formData.append('file', blob, `audio.${ext}`)
      formData.append('model_id', 'scribe_v1')

      const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': elevenLabsKey! },
        body: formData,
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        console.error('[transcribe] ElevenLabs STT error:', response.status, errText)
        return res.status(502).json({ error: `STT failed (${response.status})`, details: errText })
      }

      const data = await response.json()
      transcript = (data.text || '').trim()
      detectedLanguage = data.language_code || null
    }

    return res.status(200).json({
      transcript,
      language: detectedLanguage,
    })
  } catch (error: any) {
    console.error('[transcribe] Error:', error.message || error)
    return res.status(500).json({ error: error.message || 'Transcription failed' })
  }
}
