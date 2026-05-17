import { supabase } from '../../lib/supabase'

export interface SignalMoment {
  time: string
  title: string
  body: string
  tag: string
}

export interface NextStep {
  owner: string
  action: string
}

export interface ReadoutData {
  avatar_name: string
  contact_name: string
  duration_minutes: number
  title: string
  narrative_blocks: string[]
  signal_moments: SignalMoment[]
  perception_notes: string[]
  next_steps: NextStep[]
  closing_read: string
}

export interface ReadoutSession {
  session_id: string
  avatar_name: string
  user_name: string
  call_duration_seconds: number
  created_at: string
  readout_json: ReadoutData | null
}

export async function fetchReadoutSessions(userId: string): Promise<ReadoutSession[]> {
  if (!userId) return []

  const { data: contacts } = await supabase
    .from('wa_contacts')
    .select('id')
    .eq('email', (await supabase.auth.getUser()).data.user?.email || '')

  if (!contacts || contacts.length === 0) return []

  const contactIds = contacts.map((c: { id: string }) => c.id)

  const { data: conversations } = await supabase
    .from('wa_conversations')
    .select('id, owner_id, contact_id')
    .in('contact_id', contactIds)

  if (!conversations || conversations.length === 0) return []

  const { data: summaries, error } = await supabase
    .from('wa_session_summaries')
    .select('session_id, avatar_name, user_name, call_duration_seconds, created_at, readout_json')
    .not('readout_json', 'is', null)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error || !summaries) {
    console.error('[Readouts] Failed to fetch sessions:', error)
    return []
  }

  return summaries
    .map((s: Record<string, unknown>) => {
      let readout = s.readout_json as ReadoutData | string | null
      if (typeof readout === 'string') {
        try { readout = JSON.parse(readout) as ReadoutData } catch { readout = null }
      }
      // Filter out empty/invalid readouts
      if (!readout || typeof readout !== 'object' || !readout.title || !readout.narrative_blocks?.length) {
        return null
      }
      return {
        session_id: String(s.session_id || ''),
        avatar_name: String(s.avatar_name || ''),
        user_name: String(s.user_name || 'Participante'),
        call_duration_seconds: Number(s.call_duration_seconds || 0),
        created_at: String(s.created_at || ''),
        readout_json: readout,
      }
    })
    .filter((s): s is ReadoutSession => s !== null)
}
