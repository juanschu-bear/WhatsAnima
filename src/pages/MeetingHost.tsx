import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { createOwnerIfNeeded } from '../lib/api'
import { resolveAvatarUrl } from '../lib/avatars'

type MeetingSession = {
  token: string
  topic: string
  participants: Array<{ name: string; role: string }>
  owner?: {
    id: string
    display_name: string | null
  } | null
  join_url?: string
}

export default function MeetingHost() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [ownerId, setOwnerId] = useState<string | null>(null)
  const [ownerName, setOwnerName] = useState('Avatar')
  const [topic, setTopic] = useState('')
  const [busy, setBusy] = useState(false)
  const [session, setSession] = useState<MeetingSession | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!user) return
    let cancelled = false
    createOwnerIfNeeded({
      userId: user.id,
      email: String(user.email || ''),
      displayName: String(user.user_metadata?.full_name || user.email || 'Owner'),
    })
      .then((owner) => {
        if (cancelled) return
        setOwnerId(owner.id)
        setOwnerName(owner.display_name || owner.email || 'Avatar')
      })
      .catch((loadError) => {
        if (cancelled) return
        setError(loadError instanceof Error ? loadError.message : 'Unable to resolve owner profile')
      })
    return () => { cancelled = true }
  }, [user])

  const avatarImage = useMemo(() => resolveAvatarUrl(ownerName), [ownerName])
  const inviteLink = session?.join_url || (session?.token ? `${window.location.origin}/meeting/${session.token}` : '')

  async function createMeeting() {
    if (!ownerId) {
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
          owner_id: ownerId,
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

  return (
    <div className="brand-scene min-h-[100dvh] px-4 py-8 text-white sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="brand-panel rounded-[28px] p-6 sm:p-8">
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

          <div className="mt-6 grid gap-3 sm:grid-cols-[1fr_auto]">
            <input
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="Meeting topic (optional)"
              className="rounded-2xl border border-white/10 bg-[#08111a] px-4 py-3 text-sm text-white outline-none focus:border-[#00a884]/60"
            />
            <button
              type="button"
              onClick={() => void createMeeting()}
              disabled={busy}
              className="rounded-2xl bg-[#00a884] px-5 py-3 text-sm font-semibold text-[#08111a] transition hover:brightness-110 disabled:opacity-70"
            >
              {busy ? 'Creating...' : 'Create Meeting'}
            </button>
          </div>

          {error ? (
            <div className="mt-4 rounded-2xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">{error}</div>
          ) : null}

          {session ? (
            <div className="mt-6 space-y-4">
              <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                <p className="text-[11px] uppercase tracking-[0.18em] text-white/45">Invite Link</p>
                <p className="mt-2 break-all text-sm text-white/85">{inviteLink}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void copyInvite()}
                    className="rounded-xl border border-white/12 bg-white/[0.05] px-3 py-2 text-xs text-white/85 transition hover:bg-white/[0.08]"
                  >
                    {copied ? 'Copied' : 'Invite'}
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
                    onClick={() => navigate(`/video-call/meeting-${session.token}?meeting_token=${encodeURIComponent(session.token)}`)}
                    className="rounded-xl bg-[#00a884] px-3 py-2 text-xs font-semibold text-[#08111a] transition hover:brightness-110"
                  >
                    Start Live Call
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
                      No one joined yet.
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
