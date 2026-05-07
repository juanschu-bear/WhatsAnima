import { getSupabaseAdmin, logLiveSessionEvent, normalizeBody } from './_lib/liveSessionAudit.js'
import { syncChannelState } from './_lib/channelConsistency.js'
import { buildCurrentTimeContext, normalizeTimezone as normalizeTemporalTimezone } from './_lib/temporalCore.js'
import { normalizeCallSummaryText } from './_lib/callSummary.js'
import { getKnowledgeBaseContent } from './_lib/knowledgeBase.js'

const LIVE_CALL_API_BASE =
  process.env.LIVE_CALL_API_BASE ||
  process.env.VITE_LIVE_CALL_API_BASE ||
  'https://boardroom-api.onioko.com'
const JUAN_LOCKED_PERSONA_ID = 'p3ba4e8a40d1'
const JUAN_LOCKED_REPLICA_ID = 'rf5414018e80'

function normalizeBackendBaseUrl(value: string) {
  const normalized = value.replace(/\/+$/, '').replace(/\/api$/, '')
  if (normalized === 'https://anima.onioko.com') {
    return 'https://boardroom-api.onioko.com'
  }
  return normalized
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

const PERSONA_SLUG_BY_DISPLAY_NAME: Record<string, string> = {
  'trace flores': 'public:atlas_persona-1.5-live',
  'trace flores (haiku)': 'public:atlas_persona-1.5-live',
  'jordan cash': 'public:cosmo_persona-1.5-live',
  'jordan cash (haiku)': 'public:cosmo_persona-1.5-live',
}

function resolvePersonaSlug(displayName: string, settingsSlug: unknown): string | null {
  const fromSettings = String(settingsSlug || '').trim()
  if (fromSettings) return fromSettings
  const normalized = displayName.trim().toLowerCase()
  return PERSONA_SLUG_BY_DISPLAY_NAME[normalized] || null
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

type MeetingSessionRow = {
  id: string
  owner_id: string | null
  token: string
  topic: string | null
  participants: unknown
  expires_at: string | null
  live_session_id?: string | null
  live_join_url?: string | null
}

async function loadMeetingSession(supabase: any, meetingToken: string): Promise<{ meeting: MeetingSessionRow | null; error: string | null }> {
  const primary = await supabase
    .from('wa_meeting_sessions')
    .select('id, owner_id, token, topic, participants, expires_at, live_session_id, live_join_url')
    .eq('token', meetingToken)
    .maybeSingle()

  if (!primary.error) {
    return { meeting: primary.data as MeetingSessionRow | null, error: null }
  }

  const fallback = await supabase
    .from('wa_meeting_sessions')
    .select('id, owner_id, token, topic, participants, expires_at')
    .eq('token', meetingToken)
    .maybeSingle()

  if (fallback.error) {
    return { meeting: null, error: fallback.error.message || 'Failed to load meeting context' }
  }

  return {
    meeting: fallback.data
      ? {
          ...(fallback.data as MeetingSessionRow),
          live_session_id: null,
          live_join_url: null,
        }
      : null,
    error: null,
  }
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
  const contactId = String(body.contact_id || body.contactId || '').trim()
  const contactName = String(body.contact_name || body.contactName || '').trim()
  const timezone = normalizeTemporalTimezone(String(body.timezone || 'UTC').trim() || 'UTC')
  const incomingCallId = String(body.incoming_call_id || body.incomingCallId || '').trim()
  const meetingToken = String(body.meeting_token || body.meetingToken || '').trim()
  const meetingGuestJoinOnly = Boolean(body.meeting_guest_join_only)
  const conversationIdForRequest = conversationId || (meetingToken ? `meeting-${meetingToken}` : '')

  const requestedPersonaName = String(body.persona_name || body.persona || '').trim()
  const incomingPersonaSlug = String(body.persona_slug || '').trim()
  let resolvedPersonaSlug = incomingPersonaSlug || resolvePersonaSlug(requestedPersonaName, null)
  let isKeyframeRequest = Boolean(resolvedPersonaSlug)

  const requestBody: Record<string, unknown> = {
    persona_name: body.persona_name,
    persona: body.persona,
    language: body.language,
    timezone,
    user_name: body.user_name,
    conversation_id: conversationIdForRequest,
    owner_id: ownerId || null,
    contact_id: contactId || null,
    contact_name: contactName || null,
    incoming_call_id: incomingCallId || null,
  }
  if (resolvedPersonaSlug) {
    requestBody.persona_slug = resolvedPersonaSlug
  } else {
    requestBody.persona_id = body.persona_id
    requestBody.replica_id = body.replica_id
  }
  let initialBackendPayload: Record<string, unknown> | null = null
  let initialBackendStatus: number | null = null
  try {
    const initialResponse = await fetch(`${backendBaseUrl}/api/sessions/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
    initialBackendStatus = initialResponse.status
    const initialText = await initialResponse.text()
    initialBackendPayload = initialText ? JSON.parse(initialText) : {}

  } catch (error) {
    console.warn('[video-call] initial backend probe failed', error)
  }
  const normalizedLanguageCode = normalizeLanguageCode(body.language)
  const languageInstruction = buildLiveLanguageInstruction(normalizedLanguageCode)
  const currentTimeContext = buildCurrentTimeContext(timezone, normalizedLanguageCode)
  let finalInstruction = languageInstruction
  requestBody.language_instruction = finalInstruction
  requestBody.system_prompt_append = `${currentTimeContext}\n\n${finalInstruction}`
  requestBody.prompt_overrides = {
    language_policy: languageInstruction,
    response_language: normalizedLanguageCode,
    current_time_context: currentTimeContext,
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
    await syncChannelState({
      supabase,
      conversationId,
      channel: 'video',
      timezone,
      callStatus: 'starting',
      messageText: String(body.persona_name || body.persona || ''),
    })
  }

  if (supabase && conversationId) {
    try {
      const [{ data: memoryRow }, { data: messages }, { data: callSummaryRows }, { data: outboundCall }, { data: temporalEvents }, { data: temporalPrefs }, { data: temporalPatterns }] = await Promise.all([
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
        supabase
          .from('wa_messages')
          .select('content, created_at, type')
          .eq('conversation_id', conversationId)
          .or('type.eq.call_summary,content.ilike.[Call summary]%')
          .order('created_at', { ascending: false })
          .limit(8),
        incomingCallId
          ? supabase
              .from('wa_outbound_calls')
              .select('id, trigger_text, requested_at, requested_by_message_id, metadata')
              .eq('id', incomingCallId)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        contactId
          ? supabase
              .from('wa_temporal_events')
              .select('id, event_type, trigger_at, status, action')
              .eq('user_id', contactId)
              .in('status', ['pending', 'triggered'])
              .order('trigger_at', { ascending: true })
              .limit(8)
          : Promise.resolve({ data: [] }),
        contactId && requestedPersonaName
          ? supabase
              .from('wa_temporal_preferences')
              .select('timezone, quiet_hours_start, quiet_hours_end, reminder_lead_minutes, morning_briefing, proactive_calls')
              .eq('user_id', contactId)
              .eq('avatar_name', requestedPersonaName)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        contactId
          ? supabase
              .from('wa_temporal_patterns')
              .select('pattern_type, pattern_data, detected_at')
              .eq('user_id', contactId)
              .eq('active', true)
              .order('detected_at', { ascending: false })
              .limit(10)
          : Promise.resolve({ data: [] }),
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
      const callSummaries = (callSummaryRows ?? [])
        .map((row) => ({
          created_at: row.created_at,
          text: normalizeCallSummaryText(String(row.content || '').replace(/^\[Call summary\]\s*/i, '').trim()),
        }))
        .filter((row) => row.text.length > 0)

      requestBody.session_memory = {
        summary: memorySummary || null,
        key_facts: keyFacts,
        behavioral_profile: behavioralProfile,
        recent_messages: recentMessages,
        call_summaries: callSummaries,
        temporal_events: temporalEvents || [],
        temporal_preferences: temporalPrefs || null,
        temporal_patterns: temporalPatterns || [],
        outbound_call: outboundCall
          ? {
              id: outboundCall.id,
              trigger_text: String(outboundCall.trigger_text || '').trim() || null,
              requested_at: outboundCall.requested_at || null,
              requested_by_message_id: outboundCall.requested_by_message_id || null,
            }
          : null,
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
      if (callSummaries.length > 0) {
        const compactSummaries = callSummaries
          .slice(0, 3)
          .map((entry) => {
            const ts = String(entry.created_at || '').trim()
            const when = ts ? new Date(ts).toISOString() : 'unknown-time'
            return `[${when}] ${entry.text}`
          })
        if (compactSummaries.length > 0) {
          memoryLines.push(`Previous call summaries: ${compactSummaries.join(' || ')}`)
          memoryLines.push(
            'You DO have access to prior calls via these summaries. If asked about previous calls, answer using this history naturally.',
          )
          memoryLines.push(
            'Never claim that you have no memory of previous calls when summaries are present. Use them directly and then ask one clarifying follow-up question if needed.',
          )
        }
      }
      if (outboundCall) {
        const triggerText = String(outboundCall.trigger_text || '').trim()
        const metadata = outboundCall.metadata && typeof outboundCall.metadata === 'object'
          ? outboundCall.metadata as Record<string, unknown>
          : {}
        const onboardingFromMetadata = Boolean(metadata.onboarding)
        const isOnboardingTrigger = triggerText === 'onboarding_first_call' || onboardingFromMetadata
        if (triggerText) {
          memoryLines.push(`Call handoff reason: User asked in chat: "${triggerText}"`)
        }
        if (isOnboardingTrigger) {
          memoryLines.push(
            'Onboarding mode: this is the very first call. Greet warmly, explain that this call is to get to know the user, ask goals and background, summarize at the end, and keep language natural and non-technical.',
          )
          requestBody.onboarding_mode = true
          requestBody.onboarding_trigger_text = 'onboarding_first_call'
        }
        const onboardingUserId = String(metadata.user_id || '').trim()
        if (onboardingUserId) {
          requestBody.onboarding_user_id = onboardingUserId
        }

        const outboundDocumentIds = Array.isArray(metadata.document_ids)
          ? metadata.document_ids.map((value) => String(value || '').trim()).filter(Boolean).slice(0, 8)
          : []
        if (outboundDocumentIds.length > 0) {
          const { data: documentRows } = await supabase
            .from('wa_documents')
            .select('id, file_name')
            .in('id', outboundDocumentIds)
            .limit(5)
          const { data: chunkRows } = await supabase
            .from('wa_document_chunks')
            .select('document_id, chunk_index, content')
            .in('document_id', outboundDocumentIds)
            .order('chunk_index', { ascending: true })
            .limit(12)

          const chunksByDoc = new Map<string, string[]>()
          for (const row of chunkRows || []) {
            const documentId = String(row.document_id || '').trim()
            if (!documentId) continue
            const content = String(row.content || '').trim()
            if (!content) continue
            const current = chunksByDoc.get(documentId) || []
            if (current.length < 2) {
              current.push(content.slice(0, 550))
              chunksByDoc.set(documentId, current)
            }
          }

          const documentLines: string[] = []
          for (const row of documentRows || []) {
            const documentId = String(row.id || '').trim()
            const title = String(row.file_name || 'Shared document').trim()
            const excerpts = chunksByDoc.get(documentId) || []
            for (const excerpt of excerpts) {
              documentLines.push(`[${title}] ${excerpt}`)
            }
          }
          if (documentLines.length > 0) {
            memoryLines.push('[SHARED DOCUMENT CONTEXT]')
            memoryLines.push(...documentLines)
            memoryLines.push('Refer to this document content naturally during the call when relevant.')
          }
        }
      }
      if (Array.isArray(temporalEvents) && temporalEvents.length > 0) {
        const upcoming = temporalEvents
          .slice(0, 4)
          .map((event) => `${event.event_type} @ ${event.trigger_at}`)
        memoryLines.push(`Temporal events: ${upcoming.join(' | ')}`)
      }
      if (temporalPrefs) {
        memoryLines.push(
          `Temporal preferences: quiet ${temporalPrefs.quiet_hours_start || '-'}-${temporalPrefs.quiet_hours_end || '-'}, proactive_calls=${String(temporalPrefs.proactive_calls)}`,
        )
      }
      if (Array.isArray(temporalPatterns) && temporalPatterns.length > 0) {
        const pat = temporalPatterns.slice(0, 3).map((p) => p.pattern_type)
        memoryLines.push(`Temporal pattern hints: ${pat.join(', ')}`)
      }
      if (memoryLines.length > 0) {
        requestBody.memory_context = memoryLines.join('\n')
      }
      requestBody.memory_context = `${currentTimeContext}\n\n${String(requestBody.memory_context || '').trim()}\n\n${finalInstruction}`.trim()
    } catch (error) {
      console.error('[video-call] memory fetch failed', error)
    }
  }

  if (supabase && ownerId) {
    try {
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

      if (!isKeyframeRequest && !requestBody.persona_id && ownerPersonaId) {
        requestBody.persona_id = ownerPersonaId
      }
      if (!isKeyframeRequest && !requestBody.replica_id && ownerReplicaId) {
        requestBody.replica_id = ownerReplicaId
      }

      const resolvedSlug = incomingPersonaSlug || resolvePersonaSlug(ownerDisplayName, ownerSettings?.persona_slug)
      if (resolvedSlug) {
        resolvedPersonaSlug = resolvedSlug
        isKeyframeRequest = true
        requestBody.persona_slug = resolvedSlug
        delete requestBody.persona_id
        delete requestBody.replica_id
        console.log('[video-call] persona_slug_resolved', {
          ownerId,
          ownerDisplayName: ownerDisplayName || null,
          personaSlug: resolvedSlug,
          source: incomingPersonaSlug
            ? 'request'
            : ownerSettings?.persona_slug
              ? 'owner_settings'
              : 'display_name_mapping',
        })
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
    } catch (error) {
      console.error('[video-call] owner context load failed', error)
    }
  }

  let activeMeetingRoom: { sessionId: string; joinUrl: string } | null = null
  let meetingSessionIdToPersist: string | null = null

  if (supabase && meetingToken) {
    try {
      const { meeting, error: meetingError } = await loadMeetingSession(supabase, meetingToken)
      if (meetingError) {
        console.error('[video-call] meeting session lookup failed', { meetingToken, meetingError })
      } else if (!meeting) {
        console.warn('[video-call] meeting session missing, falling back to direct call', { meetingToken })
      } else if (meeting.expires_at && new Date(meeting.expires_at).getTime() < Date.now()) {
        console.warn('[video-call] meeting session expired, falling back to direct call', { meetingToken })
      } else {
        meetingSessionIdToPersist = meeting.id

        const liveSessionId = String(meeting.live_session_id || '').trim()
        const liveJoinUrl = String(meeting.live_join_url || '').trim()
        if (liveJoinUrl) {
          activeMeetingRoom = {
            sessionId: liveSessionId || meeting.id,
            joinUrl: liveJoinUrl,
          }
          console.log('[video-call] meeting_session_reuse', {
            meetingToken,
            sessionId: liveSessionId || meeting.id,
            hasJoinUrl: true,
          })
        }

        const participants = normalizeMeetingParticipants(meeting.participants)
        const meetingPrompt = buildMeetingPrompt(String(meeting.topic || '').trim(), participants)
        finalInstruction = `${finalInstruction}\n\n${meetingPrompt}`.trim()
        requestBody.language_instruction = finalInstruction
        requestBody.system_prompt_append = `${currentTimeContext}\n\n${finalInstruction}`
        requestBody.prompt_overrides = {
          ...(requestBody.prompt_overrides as Record<string, unknown>),
          language_policy: finalInstruction,
          response_language: normalizedLanguageCode,
          current_time_context: currentTimeContext,
        }
        requestBody.meeting_context = {
          token: meeting.token,
          topic: meeting.topic || '',
          participants,
        }
        requestBody.group_call = true
        requestBody.daily_room_mode = 'group'
        if (!requestBody.owner_id && meeting.owner_id) {
          requestBody.owner_id = meeting.owner_id
        }
        requestBody.memory_context = `${String(requestBody.memory_context || '').trim()}\n\n${meetingPrompt}`.trim()
      }
    } catch (error) {
      console.error('[video-call] meeting context load failed', error)
    }
  }

  const requiresContextEnrichment = Boolean(conversationId || ownerId || meetingToken || incomingCallId)
  if (requiresContextEnrichment) {
    // Ensure enriched memory/owner/meeting context is actually applied.
    // The initial probe happens before enrichment and must not short-circuit the final request.
    initialBackendPayload = null
    initialBackendStatus = null
  }

  try {
    console.log('[video-call] tavus_system_prompt_preview', {
      conversationId: conversationId || null,
      ownerId: ownerId || null,
      promptFirst300: String(requestBody.system_prompt_append || requestBody.language_instruction || '').slice(0, 300),
    })

    if (activeMeetingRoom) {
      return res.status(200).json({
        session_id: activeMeetingRoom.sessionId,
        join_url: activeMeetingRoom.joinUrl,
        status: 'ready',
        meeting_shared_room: true,
      })
    }

    if (isKeyframeRequest) {
      const knowledgeBase = getKnowledgeBaseContent()
      if (knowledgeBase) {
        const knowledgePrefix = `[EXTENDED HUMAN KNOWLEDGE BASE]\n${knowledgeBase}\n\n`
        requestBody.system_prompt_append = `${knowledgePrefix}${String(requestBody.system_prompt_append || '').trim()}`.trim()
        requestBody.memory_context = `${knowledgePrefix}${String(requestBody.memory_context || '').trim()}`.trim()
        requestBody.knowledge_base = knowledgeBase
        requestBody.knowledge_base_loaded = true
      }
    }

    if (meetingSessionIdToPersist) {
      if (meetingGuestJoinOnly) {
        console.log('[video-call] meeting_guest_join_waiting_for_host', {
          meetingToken,
          reason: 'live_join_url_missing',
        })
        return res.status(409).json({
          error: 'Meeting has not started yet. Waiting for host to start live call.',
          code: 'meeting_not_live',
        })
      }
      console.log('[video-call] meeting_session_create_new', {
        meetingToken,
        reason: 'live_join_url_missing',
      })
    }

    let responseStatus = initialBackendStatus
    let payload = initialBackendPayload

    if (!payload) {
      const response = await fetch(`${backendBaseUrl}/api/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      })
      responseStatus = response.status
      const text = await response.text()
      payload = text ? JSON.parse(text) : {}
    }

    if ((responseStatus ?? 500) >= 400) {
      return res.status(responseStatus ?? 500).json(payload)
    }

    if (supabase && meetingSessionIdToPersist && payload?.session_id && payload?.join_url) {
      await supabase
        .from('wa_meeting_sessions')
        .update({
          status: 'live',
          live_session_id: String(payload.session_id),
          live_join_url: String(payload.join_url),
          live_started_at: new Date().toISOString(),
        })
        .eq('id', meetingSessionIdToPersist)
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

      await syncChannelState({
        supabase,
        conversationId: conversationId || `session:${String(payload.session_id)}`,
        channel: 'video',
        timezone,
        callStatus: 'active',
        sessionId: String(payload.session_id),
      })
    }

    return res.status(200).json(payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown session start error'
    return res.status(502).json({ error: 'Failed to start live session', detail: message })
  }
}
