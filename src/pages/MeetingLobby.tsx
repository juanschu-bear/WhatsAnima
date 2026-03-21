import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { resolveAvatarUrl } from '../lib/avatars'

type LobbyOwner = {
  id: string
  display_name: string | null
  tavus_replica_id: string | null
}

type MeetingContext = {
  token: string
  topic: string
  participants: Array<{ name: string; role: string }>
  owner: LobbyOwner | null
  live_join_url?: string | null
  live_session_id?: string | null
}

function isIOSInAppBrowserUnsupported() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  const ua = String(navigator.userAgent || '')
  const isIOS = /iPhone|iPad|iPod/i.test(ua)
  if (!isIOS) return false
  const inAppTokens = /FBAN|FBAV|Instagram|Line|WhatsApp/i.test(ua)
  const hasWebkitNoMediaDevices = Boolean((window as any).webkit) && !(navigator as any).mediaDevices
  return inAppTokens || hasWebkitNoMediaDevices
}

export default function MeetingLobby() {
  const navigate = useNavigate()
  const { token } = useParams<{ token: string }>()
  const meetingToken = (token || '').trim()
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [loading, setLoading] = useState(true)
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [meeting, setMeeting] = useState<MeetingContext | null>(null)
  const [waitingForHost, setWaitingForHost] = useState(false)
  const [guestIdentity, setGuestIdentity] = useState<{ name: string; role: string } | null>(null)
  const [unsupportedInAppBrowser, setUnsupportedInAppBrowser] = useState(false)

  useEffect(() => {
    setUnsupportedInAppBrowser(isIOSInAppBrowserUnsupported())
    const enforceIframeAllow = () => {
      const iframes = Array.from(document.querySelectorAll('iframe'))
      for (const iframe of iframes) {
        const src = String(iframe.getAttribute('src') || '')
        if (!src.includes('daily.co')) continue
        iframe.setAttribute('allow', 'camera; microphone; fullscreen; display-capture')
      }
    }
    enforceIframeAllow()
    const interval = window.setInterval(enforceIframeAllow, 800)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!meetingToken) {
      setLoading(false)
      setError('Missing meeting token.')
      return
    }

    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await fetch(`/api/meeting-join?token=${encodeURIComponent(meetingToken)}`)
        const payload = await response.json() as { error?: string; meeting_context?: MeetingContext }
        if (!response.ok) throw new Error(payload.error || 'Unable to load meeting')
        if (cancelled) return
        setMeeting(payload.meeting_context || null)
      } catch (loadError) {
        if (cancelled) return
        setError(loadError instanceof Error ? loadError.message : 'Unable to load meeting')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [meetingToken])

  useEffect(() => {
    if (!waitingForHost || !meetingToken || !guestIdentity) return
    let cancelled = false
    const poll = async () => {
      try {
        const response = await fetch(`/api/meeting-join?token=${encodeURIComponent(meetingToken)}`)
        const payload = await response.json() as { error?: string; meeting_context?: MeetingContext }
        if (!response.ok) throw new Error(payload.error || 'Unable to refresh meeting status')
        if (cancelled || !payload.meeting_context) return
        setMeeting(payload.meeting_context)
        const liveJoinUrl = String(payload.meeting_context.live_join_url || '').trim()
        const liveSessionId = String(payload.meeting_context.live_session_id || '').trim()
        if (liveJoinUrl && liveSessionId) {
          sessionStorage.setItem(`wa_meeting_context:${meetingToken}`, JSON.stringify({
            ...payload.meeting_context,
            self: guestIdentity,
          }))
          navigate(
            `/video-call?session_id=${encodeURIComponent(liveSessionId)}&meeting_token=${encodeURIComponent(meetingToken)}`,
            { replace: true },
          )
        }
      } catch (pollError) {
        if (!cancelled) {
          setError(pollError instanceof Error ? pollError.message : 'Unable to refresh meeting status')
        }
      }
    }
    void poll()
    const interval = window.setInterval(() => {
      void poll()
    }, 3000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [guestIdentity, meetingToken, navigate, waitingForHost])

  const avatarName = meeting?.owner?.display_name?.trim() || 'Avatar'
  const avatarImage = useMemo(() => resolveAvatarUrl(avatarName), [avatarName])

  async function handleJoin(event: FormEvent) {
    event.preventDefault()
    if (unsupportedInAppBrowser) {
      setError('Please open this link in Safari for the best experience.')
      return
    }
    if (!meetingToken || !name.trim()) {
      setError('Please enter your name.')
      return
    }

    setJoining(true)
    setError(null)
    setWaitingForHost(false)
    try {
      const response = await fetch('/api/meeting-join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: meetingToken,
          name: name.trim(),
          role: role.trim() || 'Participant',
        }),
      })
      const payload = await response.json() as { error?: string; meeting_context?: MeetingContext }
      if (!response.ok) throw new Error(payload.error || 'Unable to join meeting')

      if (payload.meeting_context) {
        const identity = { name: name.trim(), role: role.trim() || 'Participant' }
        setGuestIdentity(identity)
        sessionStorage.setItem(`wa_meeting_context:${meetingToken}`, JSON.stringify({
          ...payload.meeting_context,
          self: identity,
        }))
        const liveSessionId = String(payload.meeting_context.live_session_id || '').trim()
        if (liveSessionId) {
          navigate(
            `/video-call?session_id=${encodeURIComponent(liveSessionId)}&meeting_token=${encodeURIComponent(meetingToken)}`,
            { replace: true },
          )
          return
        }
      }
      setWaitingForHost(true)
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : 'Unable to join meeting')
    } finally {
      setJoining(false)
    }
  }

  return (
    <div className="brand-scene relative min-h-[100dvh] px-4 py-8 text-white sm:px-6">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-20 top-24 h-64 w-64 rounded-full bg-[#00a884]/12 blur-3xl" />
        <div className="absolute -right-24 bottom-10 h-72 w-72 rounded-full bg-cyan-400/10 blur-3xl" />
      </div>
      <div className="relative z-10 mx-auto max-w-xl">
        <div className="brand-panel pointer-events-auto rounded-[28px] p-6 sm:p-8">
          {loading ? (
            <div className="flex min-h-[220px] items-center justify-center">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/10 border-t-[#00a884]" />
            </div>
          ) : unsupportedInAppBrowser ? (
            <div className="rounded-2xl border border-amber-300/30 bg-amber-500/10 px-4 py-4 text-sm text-amber-50">
              <p className="font-semibold">Please open this link in Safari for the best experience</p>
              <p className="mt-1 text-amber-100/85">
                This in-app browser does not fully support WebRTC camera/microphone calls.
              </p>
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(window.location.href)}
                className="mt-3 rounded-xl border border-white/20 bg-white/10 px-3 py-2 text-xs font-medium text-white transition hover:bg-white/15"
              >
                Copy Link
              </button>
            </div>
          ) : error ? (
            <div className="rounded-2xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">{error}</div>
          ) : (
            <>
              <div className="flex items-center gap-4">
                <img src={avatarImage} alt={avatarName} className="h-16 w-16 rounded-2xl object-cover ring-1 ring-white/12" />
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-[0.24em] text-white/45">Meeting Lobby</p>
                  <h1 className="truncate text-2xl font-semibold">{avatarName}</h1>
                </div>
              </div>
              <p className="mt-4 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white/80">
                Topic: {meeting?.topic?.trim() || 'General discussion'}
              </p>
              <form onSubmit={handleJoin} className="pointer-events-auto mt-5 space-y-3">
                <label className="block text-xs uppercase tracking-[0.18em] text-white/45">
                  Name
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className="pointer-events-auto mt-2 w-full rounded-2xl border border-white/10 bg-[#08111a] px-4 py-3 text-sm text-white outline-none focus:border-[#00a884]/60"
                    placeholder="Your name"
                    required
                  />
                </label>
                <label className="block text-xs uppercase tracking-[0.18em] text-white/45">
                  Role
                  <input
                    value={role}
                    onChange={(event) => setRole(event.target.value)}
                    className="pointer-events-auto mt-2 w-full rounded-2xl border border-white/10 bg-[#08111a] px-4 py-3 text-sm text-white outline-none focus:border-[#00a884]/60"
                    placeholder="e.g. Founder, Investor, Product Lead"
                  />
                </label>
                <button
                  type="submit"
                  disabled={joining || waitingForHost}
                  className="pointer-events-auto w-full rounded-2xl bg-[#00a884] px-4 py-3 text-sm font-semibold text-[#08111a] transition hover:brightness-110 disabled:opacity-70"
                >
                  {joining ? 'Joining...' : waitingForHost ? 'Waiting for host...' : 'Join Live Meeting'}
                </button>
              </form>
              {waitingForHost ? (
                <div className="mt-4 flex items-center gap-3 rounded-2xl border border-[#00a884]/35 bg-[#00a884]/12 px-4 py-3 text-sm text-[#a9f7e8]">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-[#9af8ea]/40 border-t-[#9af8ea]" />
                  <span>Waiting for host to start...</span>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
