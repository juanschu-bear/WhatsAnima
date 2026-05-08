export type ChannelKind = 'chat' | 'voice' | 'video' | 'outbound' | 'system'

type SyncChannelStateInput = {
  supabase: any
  conversationId: string
  channel: ChannelKind
  timezone?: string | null
  messageText?: string | null
  callStatus?: string | null
  sessionId?: string | null
}

const TZ_FALLBACK = 'UTC'

export function normalizeTimezone(value: unknown): string {
  const tz = String(value || '').trim()
  if (!tz) return TZ_FALLBACK
  if (!tz.includes('/')) return TZ_FALLBACK
  return tz
}

export function detectLanguageSimple(input: string): 'de' | 'en' | 'es' {
  const text = String(input || '').trim().toLowerCase()
  if (!text) return 'en'
  if (/\b(hey|what|time|call|now|please|bro|thanks|today)\b/.test(text)) return 'en'
  if (/\b(hola|ll[aá]mame|ahora|hora|por favor|gracias|hoy|mañana)\b/.test(text)) return 'es'
  if (/\b(hallo|uhr|uhrzeit|jetzt|bitte|danke|heute|morgen|ruf)\b/.test(text)) return 'de'
  if (/[äöüß]/.test(text)) return 'de'
  if (/[¿¡]/.test(text)) return 'es'
  return 'en'
}

function buildConsistencyGuardContext(state: Record<string, any> | null) {
  if (!state) return ''
  const timezone = String(state.timezone || TZ_FALLBACK)
  const lastChannel = String(state.last_channel || 'unknown')
  const lastLanguage = String(state.last_language || 'en')
  const callStatus = String(state.last_call_status || 'idle')
  const hardGuard = 'Consistency hard-check: never invent conflicting facts across channels. Reuse shared state first.'

  return [
    '[CHANNEL CONSISTENCY GUARD]',
    `Shared conversation state across chat/voice/video is active.`,
    `Timezone: ${timezone}`,
    `Last channel: ${lastChannel}`,
    `Primary language: ${lastLanguage}`,
    `Call status: ${callStatus}`,
    hardGuard,
    'Never contradict this shared state between channels.',
  ].join('\n')
}

export async function syncChannelState(input: SyncChannelStateInput): Promise<{
  state: Record<string, any> | null
  consistencyContext: string
}> {
  const {
    supabase,
    conversationId,
    channel,
    timezone,
    messageText,
    callStatus,
    sessionId,
  } = input
  const cleanConversationId = String(conversationId || '').trim()
  if (!supabase || !cleanConversationId) {
    return { state: null, consistencyContext: '' }
  }

  const language = messageText ? detectLanguageSimple(messageText) : null
  const patch: Record<string, any> = {
    conversation_id: cleanConversationId,
    last_channel: channel,
    updated_at: new Date().toISOString(),
  }
  if (timezone) patch.timezone = normalizeTimezone(timezone)
  if (language) patch.last_language = language
  if (callStatus) patch.last_call_status = String(callStatus)
  if (sessionId) patch.last_session_id = String(sessionId)

  try {
    const { data: previousState } = await supabase
      .from('wa_channel_state')
      .select('*')
      .eq('conversation_id', cleanConversationId)
      .maybeSingle()

    // Hard auto-correction across channels:
    // - Trust chat for language updates
    // - Preserve canonical timezone from existing state
    if (previousState) {
      if (channel !== 'chat' && previousState.last_language && patch.last_language && previousState.last_language !== patch.last_language) {
        patch.last_language = previousState.last_language
      }
      if (previousState.timezone && patch.timezone && previousState.timezone !== patch.timezone) {
        patch.timezone = previousState.timezone
      }
    }

    const { data, error } = await supabase
      .from('wa_channel_state')
      .upsert(patch, { onConflict: 'conversation_id' })
      .select('*')
      .single()

    if (error) throw error

    return {
      state: data as Record<string, any>,
      consistencyContext: buildConsistencyGuardContext((data || null) as Record<string, any> | null),
    }
  } catch (error: any) {
    const msg = String(error?.message || '')
    if (msg.toLowerCase().includes('wa_channel_state')) {
      // Migration not applied yet; keep runtime stable.
      return { state: null, consistencyContext: '' }
    }
    console.warn('[channel-consistency] sync failed:', msg)
    return { state: null, consistencyContext: '' }
  }
}
