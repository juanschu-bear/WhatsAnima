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
  readout_json: ReadoutData
}

export interface UserGroup {
  user_name: string
  sessions: ReadoutSession[]
  total_minutes: number
  last_session: string
}

export interface AvatarGroup {
  avatar_name: string
  users: UserGroup[]
  total_sessions: number
}

function parseReadout(raw: unknown): ReadoutData | null {
  let readout = raw as ReadoutData | string | null
  if (typeof readout === 'string') {
    try { readout = JSON.parse(readout) as ReadoutData } catch { return null }
  }
  if (!readout || typeof readout !== 'object' || !readout.title || !readout.narrative_blocks?.length) {
    return null
  }
  return readout
}

export async function fetchReadoutsByAvatar(): Promise<AvatarGroup[]> {
  // Load ALL avatars from wa_owners
  const { data: owners } = await supabase
    .from('wa_owners')
    .select('id, display_name')
    .is('deleted_at', null)
    .order('display_name')

  // Load readouts
  const { data: summaries, error } = await supabase
    .from('wa_session_summaries')
    .select('session_id, avatar_name, user_name, call_duration_seconds, created_at, readout_json')
    .not('readout_json', 'is', null)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) console.error('[Readouts] fetch failed:', error)

  // Build readout map by avatar name
  const readoutMap = new Map<string, Map<string, ReadoutSession[]>>()

  for (const s of (summaries || [])) {
    const readout = parseReadout(s.readout_json)
    if (!readout) continue

    const avatarName = String(s.avatar_name || 'Unknown')
    const userName = String(s.user_name || readout.contact_name || 'Participante')

    if (!readoutMap.has(avatarName)) readoutMap.set(avatarName, new Map())
    const userMap = readoutMap.get(avatarName)!
    if (!userMap.has(userName)) userMap.set(userName, [])

    userMap.get(userName)!.push({
      session_id: String(s.session_id || ''),
      avatar_name: avatarName,
      user_name: userName,
      call_duration_seconds: Number(s.call_duration_seconds || 0),
      created_at: String(s.created_at || ''),
      readout_json: readout,
    })
  }

  // Build groups for ALL avatars
  const groups: AvatarGroup[] = []
  const seenNames = new Set<string>()

  for (const owner of (owners || [])) {
    const name = String(owner.display_name || '').trim()
    if (!name || seenNames.has(name)) continue
    seenNames.add(name)

    const userMap = readoutMap.get(name)
    const users: UserGroup[] = []
    let totalSessions = 0

    if (userMap) {
      for (const [userName, sessions] of userMap) {
        const totalMin = sessions.reduce((sum, s) => sum + Math.round(s.call_duration_seconds / 60), 0)
        const lastSession = sessions[0]?.created_at || ''
        users.push({ user_name: userName, sessions, total_minutes: totalMin, last_session: lastSession })
        totalSessions += sessions.length
      }
      users.sort((a, b) => b.last_session.localeCompare(a.last_session))
    }

    groups.push({ avatar_name: name, users, total_sessions: totalSessions })
  }

  // Sort: avatars with sessions first, then alphabetical
  groups.sort((a, b) => {
    if (a.total_sessions > 0 && b.total_sessions === 0) return -1
    if (a.total_sessions === 0 && b.total_sessions > 0) return 1
    return a.avatar_name.localeCompare(b.avatar_name)
  })

  return groups
}
