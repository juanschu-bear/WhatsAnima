export const config = {
  api: { bodyParser: { sizeLimit: '500mb' } },
}

// OPM v4.0 — async job-based API (was /api/v1/process, now POST /analyze)
const OPM_BASE = 'https://boardroom-api.onioko.com';
const OPM_POLL_INTERVAL_MS = 3000;
const OPM_TIMEOUT_MS = 180000; // 3 min max

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

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

/**
 * Call OPM v4.0 async API: POST /analyze → poll /status/{job_id} → GET /results/{job_id}
 * Matches the same flow as the direct path in mediaUtils.ts callOpmApi().
 *
 * OpenAPI spec (OPM v4.0):
 *   POST /analyze — multipart/form-data { video (binary, required), session_id, preset, orientation }
 *   GET /status/{job_id} — { status, stage, ... }
 *   GET /results/{job_id} — full analysis result
 */
async function callOpmV4(blob: Blob, filename: string, sessionId: string, preset: string): Promise<any> {
  // 1. Submit job — POST /analyze
  const formData = new FormData();
  formData.append('video', blob, filename);   // field name is "video" per OpenAPI spec
  formData.append('session_id', sessionId);
  formData.append('preset', preset);

  const submitController = new AbortController();
  const submitTimeout = setTimeout(() => submitController.abort(), 15000);

  const submitRes = await fetch(`${OPM_BASE}/analyze`, {
    method: 'POST',
    body: formData,
    signal: submitController.signal,
  });
  clearTimeout(submitTimeout);

  if (!submitRes.ok) {
    const errData = await submitRes.json().catch(() => ({}));
    throw new Error(`OPM /analyze returned ${submitRes.status}: ${errData.error || errData.detail || ''}`);
  }

  const submitData = await submitRes.json();
  const jobId = submitData.job_id;
  if (!jobId) throw new Error('OPM /analyze returned no job_id');

  console.log('[opm-process] OPM job submitted:', jobId);

  // 2. Poll status — GET /status/{job_id}
  const startTime = Date.now();
  let jobComplete = false;
  while (Date.now() - startTime < OPM_TIMEOUT_MS) {
    await delay(OPM_POLL_INTERVAL_MS);

    const statusRes = await fetch(`${OPM_BASE}/status/${jobId}`);
    if (!statusRes.ok) continue;

    const statusData = await statusRes.json();
    const jobStatus = String(statusData.status || '').toLowerCase();

    if (jobStatus === 'complete' || jobStatus === 'completed' || jobStatus === 'done') {
      jobComplete = true;
      break;
    }
    if (jobStatus === 'failed' || jobStatus === 'error') {
      throw new Error(`OPM job failed: ${statusData.error || 'unknown'}`);
    }

    console.log('[opm-process] OPM job status:', jobStatus, statusData.stage || '');
  }

  if (!jobComplete) {
    throw new Error('OPM job timed out after 180s');
  }

  // 3. Get results — GET /results/{job_id}
  const resultsRes = await fetch(`${OPM_BASE}/results/${jobId}`);
  if (!resultsRes.ok) {
    throw new Error(`OPM /results/${jobId} returned ${resultsRes.status}`);
  }

  return await resultsRes.json();
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
    const finalFilename = filename || 'audio.webm';

    // Try OPM v4.0 async API: POST /analyze → poll /status → GET /results
    let opmData: any = null;
    try {
      opmData = await callOpmV4(blob, finalFilename, conversationId, 'echo');
      console.log('[opm-process] OPM v4.0 returned results');
    } catch (opmErr: any) {
      console.warn('[opm-process] OPM v4.0 failed:', opmErr.message);
    }

    // If OPM failed, run LLM fallback on transcript
    if (!opmData) {
      console.log('[opm-process] Running LLM fallback analysis');

      let transcript: string | null = null;
      let audioDurationSec: number | null = null;
      try {
        const elevenLabsKey = process.env.ELEVENLABS_API_KEY || process.env.VITE_ELEVENLABS_API_KEY;
        if (elevenLabsKey) {
          const sttForm = new FormData();
          sttForm.append('file', blob, finalFilename);
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
