export const config = {
  api: { bodyParser: { sizeLimit: '500mb' } },
}

const OPM_URL = 'https://boardroom-api.onioko.com/api/v1/process';

/**
 * LLM-based fallback when the external OPM API is unreachable.
 * Analyzes the transcript (from ElevenLabs STT) to extract emotion,
 * behavioral summary, and conversation hooks using Claude Haiku.
 */
async function llmFallbackAnalysis(transcript: string | null, audioDurationSec: number | null) {
  if (!transcript || transcript.length < 5) return null;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[opm-process] No ANTHROPIC_API_KEY — cannot run LLM fallback');
    return null;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `Analyze this voice message transcript for emotional and behavioral signals. This is a real person speaking — extract what you can observe from their word choice, sentence structure, and communication style.

TRANSCRIPT: "${transcript}"
${audioDurationSec ? `DURATION: ${audioDurationSec}s` : ''}

Respond in EXACTLY this JSON format:
{
  "primary_emotion": "one of: neutral, happy, excited, sad, anxious, frustrated, confused, curious, confident, reflective",
  "secondary_emotion": "same options or null",
  "behavioral_summary": "1 sentence describing the speaker's communication state and intent",
  "conversation_hooks": ["1-3 short conversation hooks or follow-up topics the avatar could use"],
  "fired_rules": []
}

Base your analysis ONLY on the transcript text. Be accurate — if the tone is ambiguous, default to "neutral".`,
        }],
      }),
    });

    if (!response.ok) {
      console.warn('[opm-process] LLM fallback API error:', response.status);
      return null;
    }

    const result = await response.json();
    const text = result.content?.[0]?.text?.trim() || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      echo_analysis: {
        audio_features: {
          primary_emotion: parsed.primary_emotion || 'neutral',
          secondary_emotion: parsed.secondary_emotion || null,
          transcript,
          prosodic_summary: null,
        },
        fired_rules: parsed.fired_rules || [],
        duration_sec: audioDurationSec,
      },
      session: {
        lucid_interpretation: {
          interpretation: parsed.behavioral_summary || '',
        },
        session_analysis: {
          session_patterns: (parsed.conversation_hooks || []).map((h: string) => ({ pattern: h })),
        },
      },
      _fallback: 'llm_transcript_analysis',
    };
  } catch (err: any) {
    console.warn('[opm-process] LLM fallback failed:', err.message);
    return null;
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { audio, conversationId, contactId, filename, contentType } = req.body;
    if (!audio || !conversationId || !contactId) {
      return res.status(400).json({ error: 'audio, conversationId, and contactId are required' });
    }

    const buffer = Buffer.from(audio, 'base64');
    const blob = new Blob([buffer], { type: contentType || 'audio/webm' });

    const formData = new FormData();
    formData.append('file', blob, filename || 'audio.webm');
    formData.append('session_id', conversationId);
    formData.append('user_hash', contactId);

    // Try external OPM API with timeout
    let opmData: any = null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

      const opmResponse = await fetch(OPM_URL, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (opmResponse.ok) {
        opmData = await opmResponse.json().catch(() => null);
        console.log('[opm-process] External OPM responded OK');
      } else {
        const errText = await opmResponse.text().catch(() => '');
        console.warn('[opm-process] OPM returned', opmResponse.status, errText);
      }
    } catch (fetchErr: any) {
      console.warn('[opm-process] External OPM unreachable:', fetchErr.message);
    }

    // If external OPM failed, run LLM fallback on transcript
    if (!opmData) {
      console.log('[opm-process] External OPM failed — running LLM fallback analysis');

      // Get transcript from ElevenLabs STT (same audio)
      let transcript: string | null = null;
      let audioDurationSec: number | null = null;
      try {
        const elevenLabsKey = process.env.ELEVENLABS_API_KEY || process.env.VITE_ELEVENLABS_API_KEY;
        if (elevenLabsKey) {
          const sttForm = new FormData();
          sttForm.append('file', blob, filename || 'audio.webm');
          sttForm.append('model_id', 'scribe_v1');

          const sttRes = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
            method: 'POST',
            headers: { 'xi-api-key': elevenLabsKey },
            body: sttForm,
          });

          if (sttRes.ok) {
            const sttData = await sttRes.json();
            transcript = sttData.text?.trim() || null;
          }
        }
      } catch (sttErr: any) {
        console.warn('[opm-process] STT for fallback failed:', sttErr.message);
      }

      opmData = await llmFallbackAnalysis(transcript, audioDurationSec);
      if (opmData) {
        console.log('[opm-process] LLM fallback produced analysis');
      } else {
        console.warn('[opm-process] LLM fallback also failed — returning empty');
      }
    }

    return res.status(200).json({ success: true, data: opmData });
  } catch (error: any) {
    console.error('[opm-process] Error:', error.message || error);
    return res.status(500).json({ error: error.message || 'OPM processing failed' });
  }
}
