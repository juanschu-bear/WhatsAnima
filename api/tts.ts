const JUAN_VOICE_ID = 'lx8LAX2EUAKftVz0Dk5z'

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing ELEVENLABS_API_KEY' })
  }

  const { text, voiceId, voice_id } = req.body ?? {}

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing text' })
  }

  const resolvedVoiceId =
    (typeof voiceId === 'string' && voiceId.trim()) ||
    (typeof voice_id === 'string' && voice_id.trim()) ||
    JUAN_VOICE_ID

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${resolvedVoiceId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
          output_format: 'mp3_44100_128',
        }),
      }
    )

    if (!response.ok) {
      const errorText = await response.text()
      return res.status(response.status).json({
        error: 'ElevenLabs request failed',
        details: errorText,
      })
    }

    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    res.setHeader('Content-Type', 'audio/mpeg')
    res.setHeader('Content-Length', buffer.length.toString())
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).send(buffer)
  } catch (error) {
    return res.status(500).json({
      error: 'TTS request failed',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}
