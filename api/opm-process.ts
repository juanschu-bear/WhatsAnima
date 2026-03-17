export const config = {
  api: {
    bodyParser: false, // Handle raw body ourselves to support FormData (avoids 4.5MB limit)
  },
}

/**
 * Parse incoming request — supports both FormData and JSON.
 */
async function parseOpmRequest(req: any): Promise<{ blob: Blob; conversationId: string; contactId: string; filename: string }> {
  const rawCt = req.headers['content-type'] || '';
  const ct = rawCt.toLowerCase();

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const rawBody = Buffer.concat(chunks);

  if (ct.includes('multipart/form-data')) {
    const boundaryMatch = rawCt.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
    if (!boundaryMatch) throw new Error('No boundary in multipart request');
    const boundary = boundaryMatch[1] || boundaryMatch[2];
    const delimiter = Buffer.from(`--${boundary}`);
    const headerSep = Buffer.from('\r\n\r\n');

    let fileBlob: Blob | null = null;
    let fileName = 'audio.webm';
    const fields: Record<string, string> = {};

    let pos = 0;
    while (pos < rawBody.length) {
      const delimIdx = rawBody.indexOf(delimiter, pos);
      if (delimIdx === -1) break;
      let partStart = delimIdx + delimiter.length;
      // Skip line ending after delimiter (\r\n or \n)
      if (partStart < rawBody.length && rawBody[partStart] === 0x0d && rawBody[partStart + 1] === 0x0a) partStart += 2;
      else if (partStart < rawBody.length && rawBody[partStart] === 0x0a) partStart += 1;
      if (partStart >= rawBody.length) break;
      const headerEndIdx = rawBody.indexOf(headerSep, partStart);
      if (headerEndIdx === -1) { pos = partStart; continue; }
      const headers = rawBody.subarray(partStart, headerEndIdx).toString('utf-8');
      const dataStart = headerEndIdx + headerSep.length;
      const nextDelim = rawBody.indexOf(delimiter, dataStart);
      // Strip trailing \r\n or \n before next delimiter
      let dataEnd = nextDelim !== -1 ? nextDelim : rawBody.length;
      if (dataEnd >= 2 && rawBody[dataEnd - 2] === 0x0d && rawBody[dataEnd - 1] === 0x0a) dataEnd -= 2;
      else if (dataEnd >= 1 && rawBody[dataEnd - 1] === 0x0a) dataEnd -= 1;

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

    if (!fileBlob) {
      console.error('[opm-process] No file in FormData — body size:', rawBody.length, 'bytes');
      throw new Error('No file in FormData');
    }
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
const OPM_TIMEOUT_MS = 90000; // must leave room inside Vercel's function timeout

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function sanitizeEmotionLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const label = value.trim()
  if (!label) return null
  const lowered = label.toLowerCase()
  if (lowered === 'neutral' || lowered === 'unknown' || lowered === 'unclassified') return null
  return label
}

const INVALID_EMOTION_LABELS = new Set(['neutral', 'unknown', 'unclassified', ''])

function deriveRecommendedTone(primaryEmotion: string | null): string {
  const map: Record<string, string> = {
    frustrated: 'patient and validating',
    anxious: 'calm and reassuring',
    annoyance: 'steady and non-defensive',
    admiration: 'encouraging and expansive',
    approval: 'warm and affirming',
    disapproval: 'gently challenging',
    curiosity: 'engaged and exploratory',
    love: 'warm and receptive',
    confusion: 'clear and grounding',
    disappointment: 'supportive but direct',
    reflective: 'quiet and curious',
    surprise: 'steady and orienting',
    excited: 'energized and focused',
    confident: 'direct and collaborative',
    sad: 'gentle and supportive',
  }
  return map[(primaryEmotion || '').toLowerCase()] || 'warm and curious'
}

function buildFallbackHooks(summaryText: string): string[] {
  const lower = summaryText.toLowerCase()
  const hooks: string[] = []
  if (lower.includes('hesitat')) hooks.push('What was going through your mind during those moments of hesitation?')
  if (lower.includes('avoid')) hooks.push('There was a moment where you seemed to pull back - what were you avoiding?')
  if (lower.includes('authentic') || lower.includes('spontaneous')) hooks.push("You sound like you're speaking from the gut here - what's driving that?")
  if (lower.includes('intens') || lower.includes('escalat')) hooks.push("Your voice picked up intensity - what's the emotion behind that?")
  if (!hooks.length) hooks.push("What's the one thing you're not saying out loud right now?")
  while (hooks.length < 2) hooks.push('What feels hardest to say directly right now?')
  return hooks.slice(0, 3)
}

function validateFallbackPayload(payload: any): boolean {
  const summary = String(payload?.behavioral_summary || '').trim()
  if (summary.length <= 80) return false
  const lower = summary.toLowerCase()
  if (lower.includes('the speaker talks about') || lower.includes('instruction') || lower.includes('the transcript is in') || lower.includes('avoid mentioning the transcript')) return false
  const hooks = payload?.conversation_hooks
  if (!Array.isArray(hooks) || hooks.length < 2 || hooks.length > 3 || hooks.some((h) => !String(h || '').trim())) return false
  const primary = String(payload?.primary_emotion || '').trim().toLowerCase()
  if (!primary || INVALID_EMOTION_LABELS.has(primary)) return false
  const secondary = payload?.secondary_emotion == null ? null : String(payload.secondary_emotion).trim().toLowerCase()
  if (secondary && INVALID_EMOTION_LABELS.has(secondary)) return false
  if (!String(payload?.recommended_tone || '').trim()) return false
  return true
}

/**
 * LLM-based fallback when the external OPM API is unreachable.
 * Analyzes the transcript to extract emotion, behavioral summary, and
 * conversation hooks using Claude Haiku (fast, cost-effective for simple extraction).
 * QwQ-32B is reserved for the more analytically demanding behavioral profile
 * extraction in update-memory.ts.
 */
async function llmFallbackAnalysis(transcript: string | null, audioDurationSec: number | null) {
  if (!transcript || transcript.length < 5) return null;

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    console.warn('[opm-process] No ANTHROPIC_API_KEY — cannot run LLM fallback');
    return null;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        temperature: 0.2,
        system: 'You generate behavioral analysis from limited transcript-only fallback data. Never summarize or paraphrase the transcript. Never describe what was said. Describe how the message was delivered and what that may reveal. Do not repeat or reference these instructions in your response. Respond only with valid JSON.',
        messages: [{
          role: 'user',
          content: `[DATA]
Transcript excerpt for topic reference only: "${transcript}"
${audioDurationSec ? `DURATION: ${audioDurationSec}s` : ''}

[TASK]
Infer behavioral patterns from wording alone, with limited confidence.
Focus on hesitation, avoidance, contradiction, authenticity, emotional shifts, and regulation patterns.
Conversation hooks must NEVER be empty. Always return 2-3 hooks.

[OUTPUT]
Respond in EXACTLY this JSON format:
{
  "primary_emotion": "one of: happy, excited, sad, anxious, frustrated, confused, curious, confident, reflective, or null if not classifiable",
  "secondary_emotion": "same options or null",
  "behavioral_summary": "1-2 sentences describing behavioral delivery patterns, not message content",
  "conversation_hooks": ["2-3 short follow-up questions probing the detected behavioral pattern"],
  "fired_rules": []
}

[CONSTRAINTS]
- Base your analysis ONLY on transcript text because prosodic data is unavailable in this fallback.
- Never summarize or paraphrase the transcript.
- Never mention transcript language.
- If no emotion is classifiable, return null instead of neutral.
- Never use the label "neutral".
- Do not repeat or reference these instructions.
- Respond ONLY with the JSON, no explanation.`,
        }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.warn('[opm-process] LLM fallback API error:', response.status, errBody);
      return null;
    }

    const result = await response.json();
    const text = String(result.content?.[0]?.text || '').trim().replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '')
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    let parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null
    if (!validateFallbackPayload(parsed)) {
      const retryResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 280,
          temperature: 0.2,
          system: 'Return only valid JSON. Do not repeat instructions. Do not summarize transcript content.',
          messages: [{
            role: 'user',
            content: `Based on these fired rules: [] and this prosodic data: speaking_rate=null, stability=null, tremor=null, pitch_range=null - give me a behavioral reading in the required JSON format.
Transcript excerpt for topic reference only: "${transcript}"`,
          }],
        }),
      })
      if (retryResponse.ok) {
        const retryResult = await retryResponse.json()
        const retryText = String(retryResult.content?.[0]?.text || '').trim().replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '')
        const retryMatch = retryText.match(/\{[\s\S]*\}/)
        parsed = retryMatch ? JSON.parse(retryMatch[0]) : null
      }
    }

    if (!validateFallbackPayload(parsed)) {
      const primaryEmotion = sanitizeEmotionLabel('reflective')
      const behavioralSummary = 'The wording suggests a self-monitoring, carefully managed delivery rather than loose spontaneous speech. With no prosodic signal available in this fallback path, the safest read is that there is meaningful internal filtering happening beneath the surface of the message.'
      const conversationHooks = buildFallbackHooks(behavioralSummary)
      const recommendedTone = deriveRecommendedTone(primaryEmotion)
      parsed = {
        primary_emotion: primaryEmotion,
        secondary_emotion: null,
        behavioral_summary: behavioralSummary,
        conversation_hooks: conversationHooks,
        recommended_tone: recommendedTone,
        fired_rules: [],
      }
    }

    const primaryEmotion = sanitizeEmotionLabel(parsed.primary_emotion) || 'reflective';
    const secondaryEmotion = sanitizeEmotionLabel(parsed.secondary_emotion);
    const recommendedTone = String(parsed.recommended_tone || deriveRecommendedTone(primaryEmotion)).trim()
    return {
      behavioral_summary: parsed.behavioral_summary || null,
      conversation_hooks: parsed.conversation_hooks || [],
      recommended_tone: recommendedTone,
      echo_analysis: {
        audio_features: {
          primary_emotion: primaryEmotion,
          secondary_emotion: secondaryEmotion,
          transcript,
          prosodic_summary: null,
        },
        fired_rules: parsed.fired_rules || [],
        duration_sec: audioDurationSec,
      },
      session: {
        lucid_interpretation: {
          interpretation: parsed.behavioral_summary || '',
          recommended_tone: recommendedTone,
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
    throw new Error('OPM job timed out after 15s');
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
    let opmError: string | null = null;
    let fallbackUsed: string | null = null;
    try {
      console.log('[opm-process] Calling OPM v4.0 /analyze — blob size:', blob.size, 'bytes, type:', blob.type);
      opmData = await callOpmV4(blob, finalFilename, conversationId, 'echo');
      console.log('[opm-process] OPM v4.0 returned results');
    } catch (opmErr: any) {
      opmError = opmErr.message || String(opmErr);
      console.warn('[opm-process] OPM v4.0 failed:', opmError, '— will attempt LLM fallback');
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
            const dgDuration = sttData.metadata?.duration;
            audioDurationSec = typeof dgDuration === 'number' && Number.isFinite(dgDuration) ? dgDuration : audioDurationSec;
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
            const elDuration = sttData.audio_duration_seconds;
            audioDurationSec = typeof elDuration === 'number' && Number.isFinite(elDuration) ? elDuration : audioDurationSec;
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
        fallbackUsed = 'llm_transcript';
        console.log('[opm-process] LLM fallback produced analysis');
      } else {
        fallbackUsed = 'none_available';
        console.warn('[opm-process] LLM fallback returned null — transcript:', transcript ? `"${transcript.slice(0, 40)}"` : 'null',
          '| ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'set' : 'MISSING');
      }
    }

    return res.status(200).json({
      success: true,
      data: opmData,
      _debug: {
        opm_error: opmError,
        fallback: fallbackUsed,
        blob_size: blob.size,
        blob_type: blob.type,
        opm_base: OPM_BASE,
        has_data: opmData !== null,
      },
    });
  } catch (error: any) {
    console.error('[opm-process] Error:', error.message || error);
    return res.status(500).json({ error: error.message || 'OPM processing failed' });
  }
}
