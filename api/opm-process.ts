export const config = {
  api: {
    bodyParser: false, // Handle raw body ourselves to support FormData (avoids 4.5MB limit)
  },
}

/**
 * Parse incoming request — supports both FormData and JSON.
 */
async function parseOpmRequest(req: any): Promise<{ blob: Blob; conversationId: string; contactId: string; filename: string }> {
  const ct = (req.headers['content-type'] || '').toLowerCase();

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const rawBody = Buffer.concat(chunks);

  if (ct.includes('multipart/form-data')) {
    const boundaryMatch = ct.match(/boundary=(.+?)(?:;|$)/);
    if (!boundaryMatch) throw new Error('No boundary in multipart request');
    const boundary = boundaryMatch[1];
    const delimiter = Buffer.from(`--${boundary}`);
    const headerSep = Buffer.from('\r\n\r\n');

    let fileBlob: Blob | null = null;
    let fileName = 'audio.webm';
    const fields: Record<string, string> = {};

    let pos = 0;
    while (pos < rawBody.length) {
      const delimIdx = rawBody.indexOf(delimiter, pos);
      if (delimIdx === -1) break;
      const partStart = delimIdx + delimiter.length + 2;
      if (partStart >= rawBody.length) break;
      const headerEndIdx = rawBody.indexOf(headerSep, partStart);
      if (headerEndIdx === -1) { pos = partStart; continue; }
      const headers = rawBody.subarray(partStart, headerEndIdx).toString('utf-8');
      const dataStart = headerEndIdx + headerSep.length;
      const nextDelim = rawBody.indexOf(delimiter, dataStart);
      const dataEnd = nextDelim !== -1 ? nextDelim - 2 : rawBody.length;

      const nameMatch = headers.match(/name="([^"]+)"/);
      if (!nameMatch) { pos = partStart; continue; }
      const name = nameMatch[1];

      if (headers.includes('filename=')) {
        // File part
        const partCt = headers.match(/Content-Type:\s*(.+?)(?:\r\n|$)/i)?.[1]?.trim() || 'audio/webm';
        const fnMatch = headers.match(/filename="([^"]+)"/);
        if (fnMatch) fileName = fnMatch[1];
        fileBlob = new Blob([rawBody.subarray(dataStart, dataEnd)], { type: partCt });
      } else {
        // Text field
        fields[name] = rawBody.subarray(dataStart, dataEnd).toString('utf-8');
      }
      pos = partStart;
    }

    if (!fileBlob) throw new Error('No file in FormData');
    return {
      blob: fileBlob,
      conversationId: fields.conversationId || '',
      contactId: fields.contactId || '',
      filename: fileName,
    };
  }

  // JSON body (legacy)
  const json = JSON.parse(rawBody.toString('utf-8'));
  const buffer = Buffer.from(json.audio, 'base64');
  return {
    blob: new Blob([buffer], { type: json.contentType || 'audio/webm' }),
    conversationId: json.conversationId || '',
    contactId: json.contactId || '',
    filename: json.filename || 'audio.webm',
  };
}

// OPM v4.0 — async job-based API (was /api/v1/process, now POST /analyze)
const OPM_BASE = 'https://boardroom-api.onioko.com';
const OPM_POLL_INTERVAL_MS = 3000;
const OPM_TIMEOUT_MS = 90000; // 90s — must fit inside Vercel's 120s function timeout with buffer for fallback

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * LLM-based fallback when the external OPM API is unreachable.
 * Analyzes the transcript (from ElevenLabs STT) to extract emotion,
 * behavioral summary, and conversation hooks using Qwen QWQ-32B (Cloudflare Workers AI).
 */
async function llmFallbackAnalysis(transcript: string | null, audioDurationSec: number | null) {
  if (!transcript || transcript.length < 5) return null;

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_AI_TOKEN;
  if (!accountId || !apiToken) {
    console.warn('[opm-process] No Cloudflare AI credentials — cannot run LLM fallback');
    return null;
  }

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/qwen/qwq-32b`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
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

Base your analysis ONLY on the transcript text. Be accurate — if the tone is ambiguous, default to "neutral". Respond ONLY with the JSON, no explanation.`,
          }],
        }),
      }
    );

    if (!response.ok) {
      console.warn('[opm-process] LLM fallback API error:', response.status);
      return null;
    }

    const result = await response.json();
    const text = (result.result?.response || '').trim();
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
    const { blob, conversationId, contactId, filename } = await parseOpmRequest(req);
    if (!conversationId || !contactId) {
      return res.status(400).json({ error: 'conversationId and contactId are required' });
    }
    const finalFilename = filename || 'audio.webm';

    // Try OPM v4.0 async API: POST /analyze → poll /status → GET /results
    let opmData: any = null;
    try {
      console.log('[opm-process] Calling OPM v4.0 /analyze — blob size:', blob.size, 'bytes, type:', blob.type);
      opmData = await callOpmV4(blob, finalFilename, conversationId, 'echo');
      console.log('[opm-process] OPM v4.0 returned results');
    } catch (opmErr: any) {
      console.warn('[opm-process] OPM v4.0 failed:', opmErr.message, '— will attempt LLM fallback');
    }

    // If OPM failed, run LLM fallback on transcript
    if (!opmData) {
      console.log('[opm-process] Running LLM fallback analysis');

      let transcript: string | null = null;
      let audioDurationSec: number | null = null;
      try {
        const deepgramKey = process.env.DEEPGRAM_API_KEY;
        const elevenLabsKey = process.env.ELEVENLABS_API_KEY || process.env.VITE_ELEVENLABS_API_KEY;

        if (deepgramKey) {
          // Prefer Deepgram Nova-3 with language=multi for code-switching
          console.log('[opm-process] Fallback STT: using Deepgram Nova-3');
          const blobBuffer = Buffer.from(await blob.arrayBuffer());
          const dgContentType = (blob.type || 'audio/webm').split(';')[0];

          const sttRes = await fetch(
            'https://api.deepgram.com/v1/listen?model=nova-3&language=multi&smart_format=true',
            {
              method: 'POST',
              headers: {
                'Authorization': `Token ${deepgramKey}`,
                'Content-Type': dgContentType,
              },
              body: blobBuffer,
            }
          );

          if (sttRes.ok) {
            const sttData = await sttRes.json();
            transcript = sttData.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || null;
            console.log('[opm-process] Deepgram transcript:', transcript ? `"${transcript.slice(0, 80)}..."` : '(empty)');
          } else {
            console.warn('[opm-process] Deepgram STT error:', sttRes.status, await sttRes.text().catch(() => ''));
          }
        } else if (elevenLabsKey) {
          // Fallback: ElevenLabs Scribe v1
          console.log('[opm-process] Fallback STT: using ElevenLabs Scribe');
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
            console.log('[opm-process] ElevenLabs transcript:', transcript ? `"${transcript.slice(0, 80)}..."` : '(empty)');
          } else {
            console.warn('[opm-process] ElevenLabs STT error:', sttRes.status, await sttRes.text().catch(() => ''));
          }
        } else {
          console.warn('[opm-process] No STT API keys available (DEEPGRAM_API_KEY, ELEVENLABS_API_KEY) — cannot transcribe for LLM fallback');
        }
      } catch (sttErr: any) {
        console.warn('[opm-process] STT for fallback failed:', sttErr.message);
      }

      opmData = await llmFallbackAnalysis(transcript, audioDurationSec);
      if (opmData) {
        console.log('[opm-process] LLM fallback produced analysis');
      } else {
        console.warn('[opm-process] LLM fallback returned null — transcript:', transcript ? `"${transcript.slice(0, 40)}"` : 'null',
          '| CLOUDFLARE_ACCOUNT_ID:', process.env.CLOUDFLARE_ACCOUNT_ID ? 'set' : 'MISSING',
          '| CLOUDFLARE_AI_TOKEN:', process.env.CLOUDFLARE_AI_TOKEN ? 'set' : 'MISSING');
      }
    }

    return res.status(200).json({ success: true, data: opmData });
  } catch (error: any) {
    console.error('[opm-process] Error:', error.message || error);
    return res.status(500).json({ error: error.message || 'OPM processing failed' });
  }
}
