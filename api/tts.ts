export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { text, voiceId } = req.body;
    if (!text) return res.status(400).json({ error: 'Text is required' });

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ElevenLabs API key not configured' });

    const voice = voiceId || 'lx8LAX2EUAKftVz0Dk5z';
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}`;

    const elRes = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    });

    if (!elRes.ok) {
      const errText = await elRes.text();
      console.error('[tts] ElevenLabs error:', elRes.status, errText);
      return res.status(502).json({ error: 'TTS failed: ' + elRes.status });
    }

    const arrayBuffer = await elRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    return res.status(200).send(buffer);

  } catch (error: any) {
    console.error('[tts] Error:', error.message || error);
    return res.status(500).json({ error: error.message || 'TTS request failed' });
  }
}
