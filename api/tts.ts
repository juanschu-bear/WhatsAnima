const TTS_MAX_RETRIES = 3
const TTS_RETRY_BASE_MS = 2000
const DEFAULT_TTS_VOICE_ID =
  process.env.DEFAULT_ELEVENLABS_VOICE_ID ||
  process.env.ELEVENLABS_DEFAULT_VOICE_ID ||
  ''

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { text, voiceId } = req.body;
    if (!text) return res.status(400).json({ error: 'Text is required' });

    const apiKey = process.env.ELEVENLABS_API_KEY || process.env.VITE_ELEVENLABS_API_KEY;
    if (!apiKey) {
      console.error('[tts] FATAL: No ElevenLabs API key. Set ELEVENLABS_API_KEY env var.');
      return res.status(500).json({ error: 'Missing ELEVENLABS_API_KEY env var' });
    }

    const voice = typeof voiceId === 'string' && voiceId.trim()
      ? voiceId.trim()
      : DEFAULT_TTS_VOICE_ID;
    if (!voice) {
      return res.status(400).json({ error: 'Missing voiceId (and no default voice configured)' });
    }
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}`;

    // Only ElevenLabs designed/library voices verified to sound good on v3
    // IVCs and PVCs stay on Multilingual v2 for voice consistency
    const V3_VOICES = new Set([
      'c6SfcYrb2t09NHXiT80T', // Trace Flores
    ])
    const model_id = V3_VOICES.has(voice) ? 'eleven_v3' : 'eleven_multilingual_v2'

    const payload = JSON.stringify({
      text,
      model_id,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    });

    for (let attempt = 1; attempt <= TTS_MAX_RETRIES; attempt++) {
      const elRes = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg'
        },
        body: payload
      });

      // Retry on rate limit (429)
      if (elRes.status === 429 && attempt < TTS_MAX_RETRIES) {
        const waitMs = TTS_RETRY_BASE_MS * attempt
        console.warn(`[tts] Rate limited (429), retry ${attempt}/${TTS_MAX_RETRIES} in ${waitMs}ms`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

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
    }

    // Should not reach here, but safety net
    return res.status(502).json({ error: 'TTS failed after retries' });

  } catch (error: any) {
    console.error('[tts] Error:', error.message || error);
    return res.status(500).json({ error: error.message || 'TTS request failed' });
  }
}
