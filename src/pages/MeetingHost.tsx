import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { createOwnerIfNeeded, listAllOwners } from '../lib/api'
import { resolveAvatarUrl } from '../lib/avatars'

const LIVE_CALL_API_BASE =
  (import.meta.env.VITE_LIVE_CALL_API_BASE as string | undefined) || 'https://anima.onioko.com'

type MeetingSession = {
  token: string
  topic: string
  participants: Array<{ name: string; role: string }>
  recording_url?: string | null
  live_join_url?: string | null
  live_session_id?: string | null
  live_started_at?: string | null
  owner?: {
    id: string
    display_name: string | null
  } | null
  join_url?: string
}

type OwnerOption = {
  id: string
  display_name: string | null
}

const HOST_PRIORITY = ['juan', 'adri', 'brian']

function ownerRank(name: string) {
  const lower = name.toLowerCase()
  const index = HOST_PRIORITY.findIndex((token) => lower.includes(token))
  return index === -1 ? 99 : index
}

export default function MeetingHost() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [ownerOptions, setOwnerOptions] = useState<OwnerOption[]>([])
  const [selectedOwnerId, setSelectedOwnerId] = useState<string | null>(null)
  const [ownerName, setOwnerName] = useState('Avatar')
  const [topic, setTopic] = useState('')
  const [busy, setBusy] = useState(false)
  const [initializing, setInitializing] = useState(true)
  const [session, setSession] = useState<MeetingSession | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [hostJoinName, setHostJoinName] = useState('')
  const [hostJoinRole, setHostJoinRole] = useState('Host')
  const [joiningAsHost, setJoiningAsHost] = useState(false)
  const [startingLive, setStartingLive] = useState(false)

  useEffect(() => {
    if (!user) return
    let cancelled = false
    const load = async () => {
      try {
        const owner = await createOwnerIfNeeded({
          userId: user.id,
          email: String(user.email || ''),
          displayName: String(user.user_metadata?.full_name || user.email || 'Owner'),
        })
        if (cancelled) return

        const allOwnersRaw = await listAllOwners()
        if (cancelled) return
        const mappedOwners = (Array.isArray(allOwnersRaw) ? allOwnersRaw : [])
          .map((item) => ({
            id: String((item as any)?.id || '').trim(),
            display_name: typeof (item as any)?.display_name === 'string' ? (item as any).display_name : null,
          }))
          .filter((item) => item.id)

        const curated = mappedOwners
          .filter((item) => {
            const name = String(item.display_name || '').toLowerCase()
            return name.includes('juan') || name.includes('adri') || name.includes('brian')
          })
          .sort((left, right) => ownerRank(String(left.display_name || '')) - ownerRank(String(right.display_name || '')))

        const fallbackOwner = {
          id: String(owner.id || '').trim(),
          display_name: (owner.display_name || owner.email || 'Avatar') as string,
        }

        const nextOptions = curated.length > 0
          ? curated
          : mappedOwners.length > 0
            ? mappedOwners
            : [fallbackOwner]

        const initialOwner = nextOptions.find((item) => item.id === fallbackOwner.id) || nextOptions[0]
        setOwnerOptions(nextOptions)
        setSelectedOwnerId(initialOwner?.id || fallbackOwner.id)
        setOwnerName(String(initialOwner?.display_name || fallbackOwner.display_name || 'Avatar'))
      } catch (loadError) {
        if (cancelled) return
        setError(loadError instanceof Error ? loadError.message : 'Unable to resolve owner profile')
      } finally {
        if (!cancelled) setInitializing(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [user])

  useEffect(() => {
    if (!selectedOwnerId || ownerOptions.length === 0) return
    const selected = ownerOptions.find((item) => item.id === selectedOwnerId)
    setOwnerName(String(selected?.display_name || 'Avatar'))
  }, [ownerOptions, selectedOwnerId])

  useEffect(() => {
    const fullName = String(
      user?.user_metadata?.full_name ||
      [user?.user_metadata?.first_name, user?.user_metadata?.last_name].filter(Boolean).join(' ') ||
      user?.email ||
      '',
    ).trim()
    if (fullName && !hostJoinName.trim()) {
      setHostJoinName(fullName)
    }
  }, [hostJoinName, user])

  useEffect(() => {
    if (!session?.token) return
    const interval = window.setInterval(() => {
      void refreshParticipants()
    }, 3000)
    return () => window.clearInterval(interval)
  }, [session?.token])

  const avatarImage = useMemo(() => resolveAvatarUrl(ownerName), [ownerName])
  const inviteLink = session?.live_join_url || session?.join_url || (session?.token ? `${window.location.origin}/meeting/${session.token}` : '')
  const participantCount = session?.participants?.length || 0

  async function createMeeting() {
    if (!selectedOwnerId) {
      setError('Owner profile unavailable.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/meeting-create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner_id: selectedOwnerId,
          topic: topic.trim() || null,
        }),
      })
      const payload = await response.json() as MeetingSession & { error?: string }
      if (!response.ok) throw new Error(payload.error || 'Unable to create meeting')
      setSession(payload)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create meeting')
    } finally {
      setBusy(false)
    }
  }

  async function refreshParticipants() {
    if (!session?.token) return
    try {
      const response = await fetch(`/api/meeting-join?token=${encodeURIComponent(session.token)}`)
      const payload = await response.json() as { error?: string; meeting_context?: MeetingSession }
      if (!response.ok) throw new Error(payload.error || 'Unable to refresh meeting')
      if (!payload.meeting_context) return
      setSession((current) => current ? {
        ...current,
        participants: payload.meeting_context?.participants || [],
        recording_url: payload.meeting_context?.recording_url || current.recording_url || null,
        live_join_url: payload.meeting_context?.live_join_url || current.live_join_url || null,
        live_session_id: payload.meeting_context?.live_session_id || current.live_session_id || null,
        live_started_at: payload.meeting_context?.live_started_at || current.live_started_at || null,
      } : current)
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Unable to refresh participants')
    }
  }

  async function copyInvite() {
    if (!inviteLink) return
    try {
      await navigator.clipboard.writeText(inviteLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setError('Unable to copy invite link.')
    }
  }

  async function joinAsHost() {
    if (!session?.token) return
    const name = hostJoinName.trim()
    const role = hostJoinRole.trim() || 'Host'
    if (!name) {
      setError('Enter your name to join as host.')
      return
    }
    setJoiningAsHost(true)
    setError(null)
    try {
      const response = await fetch('/api/meeting-join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: session.token,
          name,
          role,
        }),
      })
      const payload = await response.json() as { error?: string; meeting_context?: MeetingSession }
      if (!response.ok) throw new Error(payload.error || 'Unable to join as host')
      if (payload.meeting_context) {
        setSession((current) => current ? {
          ...current,
          participants: payload.meeting_context?.participants || [],
          recording_url: payload.meeting_context?.recording_url || current.recording_url || null,
          live_join_url: payload.meeting_context?.live_join_url || current.live_join_url || null,
          live_session_id: payload.meeting_context?.live_session_id || current.live_session_id || null,
          live_started_at: payload.meeting_context?.live_started_at || current.live_started_at || null,
        } : current)
      }
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : 'Unable to join as host')
    } finally {
      setJoiningAsHost(false)
    }
  }

  function startLiveCall() {
    if (!session?.token || !selectedOwnerId) return
    const selectedOwner = ownerOptions.find((item) => item.id === selectedOwnerId)
    const selfName = hostJoinName.trim() || String(user?.user_metadata?.full_name || user?.email || 'Host')
    const selfRole = hostJoinRole.trim() || 'Host'
    sessionStorage.setItem(`wa_meeting_context:${session.token}`, JSON.stringify({
      token: session.token,
      topic: session.topic || '',
      participants: session.participants || [],
      owner: {
        id: selectedOwnerId,
        display_name: selectedOwner?.display_name || ownerName,
        tavus_replica_id: null,
      },
      self: {
        name: selfName,
        role: selfRole,
      },
    }))
    setStartingLive(true)
    setError(null)
    void fetch('/api/video-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        persona_name: selectedOwner?.display_name || ownerName,
        persona: selectedOwner?.display_name || ownerName,
        language: 'en',
        user_name: selfName,
        conversation_id: `meeting-${session.token}`,
        owner_id: selectedOwnerId,
        contact_name: selfName,
        meeting_token: session.token,
        backendBaseUrl: LIVE_CALL_API_BASE,
      }),
    })
      .then(async (response) => {
        const payload = await response.json() as { error?: string; detail?: string; join_url?: string; session_id?: string }
        if (!response.ok) throw new Error(payload.detail || payload.error || 'Unable to start live meeting')
        const nextJoinUrl = String(payload.join_url || '').trim()
        const nextSessionId = String(payload.session_id || '').trim()
        if (!nextJoinUrl || !nextSessionId) throw new Error('Live session info missing from session start')

        setSession((current) => current ? {
          ...current,
          live_join_url: nextJoinUrl,
          live_session_id: nextSessionId || current.live_session_id || null,
          live_started_at: new Date().toISOString(),
        } as MeetingSession : current)

        navigate(
          `/video-call?session_id=${encodeURIComponent(nextSessionId)}&meeting_token=${encodeURIComponent(session.token)}`,
          { replace: true },
        )
      })
      .catch((startError) => {
        setError(startError instanceof Error ? startError.message : 'Unable to start live call')
      })
      .finally(() => {
        setStartingLive(false)
      })
  }

  return (
    <div className="brand-scene min-h-[100dvh] px-4 py-8 text-white sm:px-6">
      <div className="relative z-10 mx-auto max-w-4xl">
        <div className="brand-panel pointer-events-auto rounded-[28px] p-6 sm:p-8">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-4">
              <img src={avatarImage} alt={ownerName} className="h-16 w-16 rounded-2xl object-cover ring-1 ring-white/12" />
              <div>
                <p className="text-[11px] uppercase tracking-[0.24em] text-white/45">Meeting Host</p>
                <h1 className="text-2xl font-semibold">{ownerName}</h1>
              </div>
            </div>
            <button
              type="button"
              onClick={() => navigate('/dashboard')}
              className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-white/85 transition hover:bg-white/[0.07]"
            >
              Dashboard
            </button>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-3">
            {ownerOptions.map((option) => {
              const name = String(option.display_name || 'Avatar')
              const active = option.id === selectedOwnerId
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setSelectedOwnerId(option.id)}
                  className={`flex items-center gap-3 rounded-2xl border px-3 py-3 text-left transition ${
                    active
                      ? 'border-[#00a884]/55 bg-[#00a884]/16'
                      : 'border-white/10 bg-white/[0.03] hover:border-white/25'
                  }`}
                >
                  <img src={resolveAvatarUrl(name)} alt={name} className="h-12 w-12 rounded-xl object-cover ring-1 ring-white/10" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-white">{name}</p>
                    <p className="text-xs text-white/55">{active ? 'Meeting host selected' : 'Select as host'}</p>
                  </div>
                </button>
              )
            })}
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto]">
            <input
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="Meeting topic (optional)"
              className="rounded-2xl border border-white/10 bg-[#08111a] px-4 py-3 text-sm text-white outline-none transition focus:border-[#00a884]/60"
            />
            <button
              type="button"
              onClick={() => void createMeeting()}
              disabled={busy || initializing || !selectedOwnerId}
              className="rounded-2xl bg-[#00a884] px-5 py-3 text-sm font-semibold text-[#08111a] transition hover:brightness-110 disabled:opacity-60"
            >
              {busy ? 'Creating...' : 'Create Meeting'}
            </button>
          </div>

          {error ? (
            <div className="mt-4 rounded-2xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">{error}</div>
          ) : null}

          {session ? (
            <div className="mt-6 space-y-4">
              <div className="rounded-2xl border border-[#00a884]/35 bg-[linear-gradient(180deg,rgba(0,168,132,0.18),rgba(0,168,132,0.08))] p-5 shadow-[0_20px_70px_rgba(0,0,0,0.25)]">
                <p className="text-[11px] uppercase tracking-[0.18em] text-[#9af8ea]/75">Invite Link</p>
                <p className="mt-2 break-all text-sm text-white">{inviteLink}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void copyInvite()}
                    className="rounded-xl border border-white/18 bg-white/[0.08] px-3 py-2 text-xs font-medium text-white transition hover:bg-white/[0.12]"
                  >
                    {copied ? 'Copied' : 'Copy Invite'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void refreshParticipants()}
                    className="rounded-xl border border-white/12 bg-white/[0.05] px-3 py-2 text-xs text-white/85 transition hover:bg-white/[0.08]"
                  >
                    Refresh
                  </button>
                  <button
                    type="button"
                    onClick={startLiveCall}
                    disabled={participantCount < 1 || startingLive}
                    className="rounded-xl bg-[#00a884] px-3 py-2 text-xs font-semibold text-[#08111a] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {startingLive ? 'Starting…' : `Start Live Call ${participantCount > 0 ? `(${participantCount})` : ''}`}
                  </button>
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <p className="text-[11px] uppercase tracking-[0.18em] text-white/45">Join as Host</p>
                <p className="mt-1 text-sm text-white/60">Add yourself to the participant list before starting the call.</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                  <input
                    value={hostJoinName}
                    onChange={(event) => setHostJoinName(event.target.value)}
                    placeholder="Your name"
                    className="rounded-xl border border-white/10 bg-[#08111a] px-3 py-2 text-sm text-white outline-none transition focus:border-[#00a884]/60"
                  />
                  <input
                    value={hostJoinRole}
                    onChange={(event) => setHostJoinRole(event.target.value)}
                    placeholder="Your role"
                    className="rounded-xl border border-white/10 bg-[#08111a] px-3 py-2 text-sm text-white outline-none transition focus:border-[#00a884]/60"
                  />
                  <button
                    type="button"
                    onClick={() => void joinAsHost()}
                    disabled={joiningAsHost || !hostJoinName.trim()}
                    className="rounded-xl border border-[#00a884]/40 bg-[#00a884]/20 px-3 py-2 text-sm font-semibold text-[#9af8ea] transition hover:bg-[#00a884]/28 disabled:opacity-60"
                  >
                    {joiningAsHost ? 'Joining...' : 'Join as Host'}
                  </button>
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <p className="text-[11px] uppercase tracking-[0.18em] text-white/45">Participants</p>
                <div className="mt-3 space-y-2">
                  {session.participants?.length ? session.participants.map((participant, index) => (
                    <div key={`${participant.name}-${participant.role}-${index}`} className="rounded-xl border border-white/8 bg-[#091322] px-3 py-2 text-sm text-white/85">
                      {participant.name} ({participant.role || 'Participant'})
                    </div>
                  )) : (
                    <div className="rounded-xl border border-white/8 bg-[#091322] px-3 py-2 text-sm text-white/60">
                      No one joined yet. Share the invite link and this list will update live.
                    </div>
                  )}
                </div>
                {session.recording_url ? (
                  <div className="mt-3 rounded-xl border border-white/8 bg-[#091322] px-3 py-2 text-sm text-white/80">
                    Latest recording:{' '}
                    <a href={session.recording_url} target="_blank" rel="noreferrer" className="text-[#8feee0] underline">
                      Open
                    </a>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
