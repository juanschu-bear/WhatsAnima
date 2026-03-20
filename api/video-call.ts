import { getSupabaseAdmin, logLiveSessionEvent, normalizeBody } from './_lib/liveSessionAudit.js'

const LIVE_CALL_API_BASE =
  process.env.LIVE_CALL_API_BASE ||
  process.env.VITE_LIVE_CALL_API_BASE ||
  'https://anima.onioko.com'
const JUAN_LOCKED_PERSONA_ID = 'p8c4ae75d94d'
const JUAN_LOCKED_REPLICA_ID = 'rf5414018e80'

function normalizeBackendBaseUrl(value: string) {
  return value.replace(/\/+$/, '').replace(/\/api$/, '')
}

function isJuanLockedOwner(displayName: unknown, email: unknown) {
  const normalizedName = String(displayName || '').trim().toLowerCase()
  const normalizedEmail = String(email || '').trim().toLowerCase()
  return (
    normalizedName === 'juan schubert' ||
    normalizedName === 'juan schubert (extended)' ||
    normalizedEmail === 'mwg.jmschubert@gmail.com'
  )
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

function normalizeMeetingParticipants(value: unknown): Array<{ name: string; role: string }> {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const obj = item as Record<string, unknown>
      const name = String(obj.name || '').trim()
      const role = String(obj.role || '').trim() || 'Participant'
      if (!name) return null
      return { name, role }
    })
    .filter((item): item is { name: string; role: string } => Boolean(item))
}

function buildMeetingPrompt(topic: string, participants: Array<{ name: string; role: string }>) {
  const roster =
    participants.length > 0
      ? participants.map((participant) => `- ${participant.name} (${participant.role})`).join('\n')
      : '- No participants listed yet'
  return [
    'You are in a meeting. Participants present:',
    roster,
    `Topic: ${topic || 'General discussion'}`,
    'You can see and hear everyone. Address participants by name when relevant. If someone seems thoughtful or emotional, acknowledge it naturally.',
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
  const meetingToken = String(body.meeting_token || body.meetingToken || '').trim()
  const conversationIdForRequest = conversationId || (meetingToken ? `meeting-${meetingToken}` : '')

  const requestBody: Record<string, unknown> = {
    persona_name: body.persona_name,
    persona: body.persona,
    persona_id: body.persona_id,
    replica_id: body.replica_id,
    language: body.language,
    user_name: body.user_name,
    conversation_id: conversationIdForRequest,
    owner_id: ownerId || null,
    contact_name: contactName || null,
  }
  const normalizedLanguageCode = normalizeLanguageCode(body.language)
  const languageInstruction = buildLiveLanguageInstruction(normalizedLanguageCode)
  let finalInstruction = languageInstruction
  requestBody.language_instruction = finalInstruction
  requestBody.system_prompt_append = finalInstruction
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
      requestBody.memory_context = `${String(requestBody.memory_context || '').trim()}\n\n${finalInstruction}`.trim()
    } catch (error) {
      console.error('[video-call] memory fetch failed', error)
    }
  }

  if (supabase && ownerId) {
    const { data: owner } = await supabase
      .from('wa_owners')
      .select('display_name, email, system_prompt, settings, tavus_replica_id')
      .eq('id', ownerId)
      .maybeSingle()

    const ownerDisplayName = String(owner?.display_name || '').trim()
    const ownerEmail = String(owner?.email || '').trim()
    const ownerSettings = (owner?.settings && typeof owner.settings === 'object')
      ? owner.settings as Record<string, unknown>
      : null
    const ownerPersonaId = typeof ownerSettings?.tavus_persona_id === 'string'
      ? ownerSettings.tavus_persona_id.trim()
      : ''
    const ownerReplicaId = String(owner?.tavus_replica_id || '').trim()

    if (!requestBody.persona_id && ownerPersonaId) {
      requestBody.persona_id = ownerPersonaId
    }
    if (!requestBody.replica_id && ownerReplicaId) {
      requestBody.replica_id = ownerReplicaId
    }

    if (isJuanLockedOwner(ownerDisplayName, ownerEmail)) {
      requestBody.persona_id = JUAN_LOCKED_PERSONA_ID
      requestBody.replica_id = JUAN_LOCKED_REPLICA_ID
      if (ownerDisplayName) {
        requestBody.persona_name = ownerDisplayName
        requestBody.persona = ownerDisplayName
      }
      requestBody.persona_override = true
      requestBody.juan_persona_locked = true
      console.log('[video-call] juan_persona_lock_applied', {
        ownerId,
        ownerDisplayName: ownerDisplayName || null,
        personaId: JUAN_LOCKED_PERSONA_ID,
        replicaId: JUAN_LOCKED_REPLICA_ID,
      })
    }

    if (owner?.system_prompt) {
      requestBody.system_prompt = owner.system_prompt
      requestBody.owner_system_prompt = owner.system_prompt
    }
  }

  if (supabase && meetingToken) {
    try {
      const { data: meeting, error: meetingError } = await supabase
        .from('wa_meeting_sessions')
        .select('id, owner_id, token, topic, participants, expires_at')
        .eq('token', meetingToken)
        .maybeSingle()

      if (meetingError) {
        return res.status(500).json({ error: meetingError.message || 'Failed to load meeting context' })
      }
      if (!meeting) {
        return res.status(404).json({ error: 'Meeting session not found' })
      }
      if (meeting.expires_at && new Date(meeting.expires_at).getTime() < Date.now()) {
        return res.status(410).json({ error: 'Meeting session has expired' })
      }

      const participants = normalizeMeetingParticipants(meeting.participants)
      const meetingPrompt = buildMeetingPrompt(String(meeting.topic || '').trim(), participants)
      finalInstruction = `${finalInstruction}\n\n${meetingPrompt}`.trim()
      requestBody.language_instruction = finalInstruction
      requestBody.system_prompt_append = finalInstruction
      requestBody.prompt_overrides = {
        ...(requestBody.prompt_overrides as Record<string, unknown>),
        language_policy: finalInstruction,
        response_language: normalizedLanguageCode,
      }
      requestBody.meeting_context = {
        token: meeting.token,
        topic: meeting.topic || '',
        participants,
      }
      if (!requestBody.owner_id && meeting.owner_id) {
        requestBody.owner_id = meeting.owner_id
      }
      requestBody.memory_context = `${String(requestBody.memory_context || '').trim()}\n\n${meetingPrompt}`.trim()
    } catch (error) {
      console.error('[video-call] meeting context load failed', error)
      return res.status(500).json({ error: 'Failed to prepare meeting context' })
    }
  }

  try {
    console.log('[video-call] tavus_system_prompt_preview', {
      conversationId: conversationId || null,
      ownerId: ownerId || null,
      promptFirst300: String(requestBody.system_prompt_append || requestBody.language_instruction || '').slice(0, 300),
    })

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
