import { createClient } from '@supabase/supabase-js'

export interface LiveSessionAuditPayload {
  sessionId: string
  conversationId?: string | null
  ownerId?: string | null
  personaName?: string | null
  replicaId?: string | null
  language?: string | null
  joinUrl?: string | null
  backendBaseUrl?: string | null
  status?: string | null
  endReason?: string | null
  error?: string | null
}

export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY
  if (!url) return { client: null, missing: 'SUPABASE_URL' }
  if (!key) return { client: null, missing: 'SUPABASE_SERVICE_KEY' }
  return { client: createClient(url, key), missing: null }
}

export function normalizeBody(req: any): Record<string, unknown> {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string' && req.body.trim()) {
    try {
      return JSON.parse(req.body)
    } catch {
      return {}
    }
  }
  return {}
}

export async function logLiveSessionEvent(
  supabase: ReturnType<typeof createClient>,
  payload: LiveSessionAuditPayload,
) {
  const now = new Date().toISOString()
  const row = {
    session_id: payload.sessionId,
    conversation_id: payload.conversationId ?? null,
    owner_id: payload.ownerId ?? null,
    persona_name: payload.personaName ?? null,
    replica_id: payload.replicaId ?? null,
    language: payload.language ?? null,
    join_url: payload.joinUrl ?? null,
    backend_base_url: payload.backendBaseUrl ?? null,
    status: payload.status ?? 'started',
    last_event_at: now,
    error: payload.error ?? null,
  }

  if (payload.status === 'started') {
    row.started_at = now
  }

  if (payload.status === 'ended' || payload.status === 'end_failed') {
    row.ended_at = now
    row.ended_reason = payload.endReason ?? null
  }

  const { error } = await supabase
    .from('wa_tavus_sessions')
    .upsert(row as any, { onConflict: 'session_id' })

  if (error) {
    throw error
  }
}
