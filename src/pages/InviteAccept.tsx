import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  acceptOnboardingInvitation,
  createContactForOwner,
  findContactByEmailForOwner,
  findOrCreateConversation,
  getOnboardingInvitation,
  requestOutboundCall,
  type InvitationRecord,
} from '../lib/api'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { getCanonicalAppUrl } from '../lib/canonicalOrigin'

const PENDING_KEY = 'wa_pending_onboarding_invite'

type PendingInviteState = {
  inviteCode: string
}

function isExpired(invitation: InvitationRecord | null): boolean {
  if (!invitation?.expires_at) return false
  return new Date(invitation.expires_at).getTime() <= Date.now()
}

export default function InviteAccept() {
  const { inviteCode = '' } = useParams<{ inviteCode: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [invitation, setInvitation] = useState<InvitationRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [verificationNotice, setVerificationNotice] = useState(false)

  const [accepted, setAccepted] = useState(false)
  const [startingCall, setStartingCall] = useState(false)
  const autoStartRef = useRef(false)

  const primaryAvatarName = useMemo(
    () => (invitation?.allowed_avatars?.[0] || '').trim(),
    [invitation?.allowed_avatars],
  )

  useEffect(() => {
    if (!inviteCode) {
      setError('Invitation code missing.')
      setLoading(false)
      return
    }

    void (async () => {
      const data = await getOnboardingInvitation(inviteCode)
      setInvitation(data)
      if (!data) {
        setError('This invitation link is invalid.')
      } else if (data.status !== 'pending') {
        setError('This invitation is no longer pending.')
      } else if (isExpired(data)) {
        setError('This invitation has expired.')
      } else {
        setEmail(data.invitee_email || '')
      }
      setLoading(false)
    })()
  }, [inviteCode])

  useEffect(() => {
    if (!user?.id || !invitation || accepted) return

    const raw = localStorage.getItem(PENDING_KEY)
    const pending = raw ? (JSON.parse(raw) as PendingInviteState) : null
    if (!pending || pending.inviteCode !== inviteCode) return

    void (async () => {
      try {
        await acceptOnboardingInvitation({
          inviteCode,
          userId: user.id,
          userEmail: user.email || null,
        })
        setAccepted(true)
        localStorage.removeItem(PENDING_KEY)
      } catch (acceptError) {
        setError(acceptError instanceof Error ? acceptError.message : 'Could not activate invitation.')
      }
    })()
  }, [accepted, inviteCode, invitation, user?.email, user?.id])

  async function handleSignup(event: FormEvent) {
    event.preventDefault()
    if (!email.trim() || !password.trim()) {
      setError('Please provide email and password.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setError(null)
    setSubmitting(true)
    localStorage.setItem(PENDING_KEY, JSON.stringify({ inviteCode }))

    const { error: signUpError } = await supabase.auth.signUp({
      email: email.trim(),
      password: password.trim(),
      options: {
        emailRedirectTo: getCanonicalAppUrl(`/auth/callback?next=${encodeURIComponent(`/invite/${inviteCode}`)}`),
      },
    })

    setSubmitting(false)
    if (signUpError) {
      setError(signUpError.message)
      return
    }

    setVerificationNotice(true)
  }

  async function startOnboardingCall() {
    if (!user?.id || !user.email || !invitation || !primaryAvatarName || startingCall) return
    setStartingCall(true)

    try {
      const { data: owner } = await supabase
        .from('wa_owners')
        .select('id, display_name')
        .eq('display_name', primaryAvatarName)
        .is('deleted_at', null)
        .limit(1)
        .maybeSingle()

      if (!owner?.id) {
        throw new Error(`Avatar owner not found for ${primaryAvatarName}`)
      }

      const firstName = String(user.user_metadata?.first_name || '').trim() || invitation.invitee_name || 'User'
      const lastName = String(user.user_metadata?.last_name || '').trim() || 'Invitee'
      const existingContact = await findContactByEmailForOwner(owner.id, user.email)
      const contact =
        existingContact ||
        (await createContactForOwner({
          ownerId: owner.id,
          firstName,
          lastName,
          email: user.email,
        }))

      const conversationId = await findOrCreateConversation(owner.id, contact.id)

      await requestOutboundCall({
        conversationId,
        ownerId: owner.id,
        contactId: contact.id,
        userId: user.id,
        contactEmail: user.email,
        triggerText: 'onboarding_first_call',
        language: invitation.language,
        callerDisplayName: primaryAvatarName,
      })

      navigate(`/video-call/${conversationId}`)
    } catch (callError) {
      setError(callError instanceof Error ? callError.message : 'Could not start onboarding call.')
      setStartingCall(false)
    }
  }

  useEffect(() => {
    const emailVerified = Boolean(user?.email_confirmed_at)
    if (!accepted || !emailVerified || autoStartRef.current) return
    autoStartRef.current = true
    const timer = window.setTimeout(() => {
      void startOnboardingCall()
    }, 3000)
    return () => window.clearTimeout(timer)
  }, [accepted, user?.email_confirmed_at])

  if (loading) {
    return (
      <div className="brand-scene flex min-h-screen items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-[#1f2c34] border-t-[#00a884]" />
      </div>
    )
  }

  if (error || !invitation) {
    return (
      <div className="brand-scene min-h-screen text-white">
        <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-xl items-center justify-center px-6 py-10">
          <div className="brand-panel w-full rounded-[30px] p-8 text-center">
            <h1 className="text-2xl font-bold">Invite Unavailable</h1>
            <p className="mt-3 text-sm text-white/70">{error || 'This invitation cannot be used right now.'}</p>
            <Link to="/login" className="mt-6 inline-block text-sm text-[#58e3c7] hover:text-[#00a884]">
              Back to login
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const emailVerified = Boolean(user?.email_confirmed_at)
  const welcomeReady = accepted && emailVerified

  return (
    <div className="brand-scene min-h-screen text-white">
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-xl items-center justify-center px-6 py-10">
        <div className="brand-panel w-full rounded-[30px] p-8 sm:p-10">
          {!welcomeReady ? (
            <>
              <h1 className="text-3xl font-bold tracking-tight">
                Hey {invitation.invitee_name || 'there'}, welcome to WhatsAnima
              </h1>
              <p className="mt-3 text-sm text-white/70">
                Create your account to unlock: {invitation.allowed_avatars.join(', ')}.
              </p>

              <form onSubmit={handleSignup} className="mt-8 space-y-4">
                <div>
                  <label className="mb-2 block text-sm text-white/80">Email</label>
                  <input
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                    type="email"
                    className="brand-inset w-full rounded-2xl px-4 py-3 text-white outline-none focus:border-[#00a884]"
                    placeholder="you@example.com"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm text-white/80">Password</label>
                  <input
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    type="password"
                    className="brand-inset w-full rounded-2xl px-4 py-3 text-white outline-none focus:border-[#00a884]"
                    placeholder="At least 8 characters"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm text-white/80">Confirm password</label>
                  <input
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    required
                    type="password"
                    className="brand-inset w-full rounded-2xl px-4 py-3 text-white outline-none focus:border-[#00a884]"
                    placeholder="Repeat your password"
                  />
                </div>

                {verificationNotice ? (
                  <p className="rounded-2xl border border-[#00a884]/35 bg-[#00a884]/10 px-4 py-3 text-sm text-[#89f6e2]">
                    Check your email to verify your account.
                  </p>
                ) : null}

                {error ? (
                  <p className="rounded-2xl border border-red-400/20 bg-red-500/15 px-4 py-3 text-sm text-red-200">{error}</p>
                ) : null}

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full rounded-2xl bg-[#00a884] px-4 py-3 font-semibold text-[#08111a] transition hover:brightness-110 disabled:opacity-60"
                >
                  {submitting ? 'Creating account…' : 'Create Account'}
                </button>
              </form>
            </>
          ) : (
            <>
              <h1 className="text-3xl font-bold tracking-tight">Your account is ready</h1>
              <p className="mt-3 text-sm text-white/70">
                {primaryAvatarName || 'Your avatar'} would like to get to know you.
              </p>
              <button
                type="button"
                onClick={() => void startOnboardingCall()}
                disabled={startingCall}
                className="mt-8 w-full rounded-2xl bg-[#00a884] px-4 py-3 font-semibold text-[#08111a] transition hover:brightness-110 disabled:opacity-60"
              >
                {startingCall ? 'Starting call…' : 'Start Call'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
