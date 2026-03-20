import { getSupabaseAdmin, logLiveSessionEvent, normalizeBody } from './_lib/liveSessionAudit.js'

const LIVE_CALL_API_BASE =
  process.env.LIVE_CALL_API_BASE ||
  process.env.VITE_LIVE_CALL_API_BASE ||
  'https://anima.onioko.com'

function normalizeBackendBaseUrl(value: string) {
  return value.replace(/\/+$/, '').replace(/\/api$/, '')
}

function toArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item ?? '').trim()).filter(Boolean)
}

function normalizeLanguageCode(value: unknown): 'en' | 'es' | 'de' {
  const code = String(value || '').trim().toLowerCase()
  if (code.startsWith('es')) return 'es'
  if (code.startsWith('de')) return 'de'
  return 'en'
}

function buildLiveLanguageInstruction(languageCode: 'en' | 'es' | 'de') {
  const languageName = languageCode === 'es' ? 'Spanish' : languageCode === 'de' ? 'German' : 'English'
  return [
    '[MANDATORY LANGUAGE POLICY]',
    `The user is currently speaking ${languageName}.`,
    `You MUST answer in ${languageName}, every reply, no exceptions.`,
    'Never switch to another language unless the user switches first.',
    'Mirror the user language exactly in real time.',
  ].join('\n')
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const body = normalizeBody(req)
  const backendBaseUrl = normalizeBackendBaseUrl(String(body.backendBaseUrl || LIVE_CALL_API_BASE))
  const conversationId = String(body.conversation_id || body.conversationId || '').trim()
  const ownerId = String(body.owner_id || body.ownerId || '').trim()
  const contactName = String(body.contact_name || body.contactName || '').trim()

  const requestBody: Record<string, unknown> = {
    persona_name: body.persona_name,
    persona: body.persona,
    persona_id: body.persona_id,
    replica_id: body.replica_id,
    language: body.language,
    user_name: body.user_name,
    conversation_id: conversationId || null,
    owner_id: ownerId || null,
    contact_name: contactName || null,
  }
  const normalizedLanguageCode = normalizeLanguageCode(body.language)
  const languageInstruction = buildLiveLanguageInstruction(normalizedLanguageCode)
  requestBody.language_instruction = languageInstruction
  requestBody.system_prompt_append = languageInstruction
  requestBody.prompt_overrides = {
    language_policy: languageInstruction,
    response_language: normalizedLanguageCode,
  }
  console.log('[video-call] language enforcement', {
    language: normalizedLanguageCode,
    conversationId: conversationId || null,
    ownerId: ownerId || null,
  })

  if (typeof body.max_call_duration === 'number') {
    requestBody.max_call_duration = body.max_call_duration
  }
  if (typeof body.persona_override === 'boolean') {
    requestBody.persona_override = body.persona_override
  }
  if (typeof body.glue_enabled === 'boolean') {
    requestBody.glue_enabled = body.glue_enabled
  }

  const { client: supabase } = getSupabaseAdmin()

  if (supabase && conversationId) {
    try {
      const [{ data: memoryRow }, { data: messages }] = await Promise.all([
        supabase
          .from('wa_conversation_memory')
          .select('summary, key_facts, behavioral_profile')
          .eq('conversation_id', conversationId)
          .maybeSingle(),
        supabase
          .from('wa_messages')
          .select('sender, content, type, created_at')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: false })
          .limit(10),
      ])

      const memorySummary = String(memoryRow?.summary || '').trim()
      const keyFacts = toArray(memoryRow?.key_facts)
      const behavioralProfile = memoryRow?.behavioral_profile ?? null
      const recentMessages = (messages ?? []).map((message) => ({
        sender: message.sender,
        type: message.type,
        content: message.content,
        created_at: message.created_at,
      }))

      requestBody.session_memory = {
        summary: memorySummary || null,
        key_facts: keyFacts,
        behavioral_profile: behavioralProfile,
        recent_messages: recentMessages,
      }

      const memoryLines: string[] = []
      if (memorySummary) memoryLines.push(`Summary: ${memorySummary}`)
      if (keyFacts.length > 0) memoryLines.push(`Key facts: ${keyFacts.join(' | ')}`)
      if (recentMessages.length > 0) {
        const compact = recentMessages
          .slice(0, 6)
          .map((msg) => `[${msg.sender}] ${String(msg.content || '').trim()}`)
          .filter((line) => line.length > 2)
        if (compact.length > 0) memoryLines.push(`Recent context: ${compact.join(' || ')}`)
      }
      if (memoryLines.length > 0) {
        requestBody.memory_context = memoryLines.join('\n')
      }
      requestBody.memory_context = `${String(requestBody.memory_context || '').trim()}\n\n${languageInstruction}`.trim()
    } catch (error) {
      console.error('[video-call] memory fetch failed', error)
    }
  }

  try {
    const response = await fetch(`${backendBaseUrl}/api/sessions/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    })

    const text = await response.text()
    const payload = text ? JSON.parse(text) : {}

    if (!response.ok) {
      return res.status(response.status).json(payload)
    }

    if (supabase && payload?.session_id) {
      try {
        await logLiveSessionEvent(supabase, {
          sessionId: String(payload.session_id),
          conversationId: conversationId || null,
          ownerId: ownerId || null,
          personaName: String(body.persona_name || body.persona || ''),
          replicaId: String(body.replica_id || ''),
          language: String(body.language || ''),
          joinUrl: String(payload.join_url || ''),
          backendBaseUrl,
          status: 'started',
        })
      } catch (error) {
        console.error('[video-call] audit write failed', error)
      }
    }

    return res.status(200).json(payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown session start error'
    return res.status(502).json({ error: 'Failed to start live session', detail: message })
  }
}
