export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.ELEVENLABS_API_KEY || process.env.VITE_ELEVENLABS_API_KEY
  if (!apiKey) {
    return res.status(503).json({ error: 'Missing ELEVENLABS_API_KEY' })
  }

  try {
    const { audio, contentType, languageCode } = req.body || {}
    if (!audio || typeof audio !== 'string') {
      return res.status(400).json({ error: 'audio (base64) is required' })
    }

    const buffer = Buffer.from(audio, 'base64')
    const blob = new Blob([buffer], { type: contentType || 'audio/webm' })

    const ext = (contentType || 'audio/webm').includes('mp4') ? 'm4a'
      : (contentType || '').includes('ogg') ? 'ogg'
      : 'webm'

    const formData = new FormData()
    formData.append('file', blob, `audio.${ext}`)
    formData.append('model_id', 'scribe_v1')
    if (languageCode) {
      formData.append('language_code', languageCode)
    }

    const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
      },
      body: formData,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      console.error('[transcribe] ElevenLabs STT error:', response.status, errText)
      return res.status(502).json({ error: `STT failed (${response.status})`, details: errText })
    }

    const data = await response.json()
    const transcript = data.text?.trim() || ''
    const detectedLanguage = data.language_code || null

    return res.status(200).json({
      transcript,
      language: detectedLanguage,
    })
  } catch (error: any) {
    console.error('[transcribe] Error:', error.message || error)
    return res.status(500).json({ error: error.message || 'Transcription failed' })
  }
}
