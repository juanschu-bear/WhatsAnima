import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  acceptOnboardingInvitation,
  getOnboardingInvitation,
  type InvitationRecord,
} from '../lib/api'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { getCanonicalAppUrl } from '../lib/canonicalOrigin'

const PENDING_KEY = 'wa_pending_onboarding_invite'
const SIGNUP_DONE_KEY_PREFIX = 'wa_onboarding_signup_done:'

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
  const [showVerificationScreen, setShowVerificationScreen] = useState(false)

  const [accepted, setAccepted] = useState(false)
  const acceptedRef = useRef(false)

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
        setError('Dieser Einladungslink ist ungültig.')
      } else if (data.status !== 'pending') {
        setError(
          data.status === 'accepted'
            ? 'Dieser Einladungslink wurde bereits verwendet.'
            : 'Dieser Einladungslink kann nicht mehr verwendet werden.',
        )
      } else if (isExpired(data)) {
        setError('Dieser Einladungslink ist abgelaufen. Bitte fordere einen neuen an.')
      } else {
        setEmail(data.invitee_email || '')
      }
      setLoading(false)
    })()
  }, [inviteCode])

  useEffect(() => {
    if (!inviteCode) return
    try {
      const persisted = sessionStorage.getItem(`${SIGNUP_DONE_KEY_PREFIX}${inviteCode}`)
      if (persisted === '1') setShowVerificationScreen(true)
    } catch {
      // ignore storage errors
    }
  }, [inviteCode])

  useEffect(() => {
    if (user?.email_confirmed_at) {
      navigate('/onboarding', { replace: true })
    }
  }, [navigate, user?.email_confirmed_at])

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

    const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
      email: email.trim(),
      password: password.trim(),
      options: {
        emailRedirectTo: getCanonicalAppUrl(`/auth/callback?next=${encodeURIComponent('/onboarding')}`),
        data: {
          invite_code: inviteCode,
          invitee_name: invitation?.invitee_name || '',
          language: invitation?.language || 'en',
        },
      },
    })

    if (signUpError) {
      const normalized = String(signUpError.message || '').toLowerCase()
      if (normalized.includes('already registered') || normalized.includes('already been registered') || normalized.includes('user already')) {
        setError('Diese E-Mail ist bereits registriert. Bitte logge dich ein oder nutze eine andere E-Mail.')
      } else {
        setError(signUpError.message)
      }
      setSubmitting(false)
      return
    }

    const userId = String(signUpData?.user?.id || '').trim()
    if (userId && !acceptedRef.current) {
      try {
        await acceptOnboardingInvitation({
          inviteCode,
          userId,
          userEmail: email.trim(),
        })
        acceptedRef.current = true
        setAccepted(true)
      } catch (acceptError) {
        setError(acceptError instanceof Error ? acceptError.message : 'Einladung konnte nicht aktiviert werden.')
        setSubmitting(false)
        return
      }
    }

    setSubmitting(false)
    setShowVerificationScreen(true)
    setPassword('')
    setConfirmPassword('')
    try {
      sessionStorage.setItem(`${SIGNUP_DONE_KEY_PREFIX}${inviteCode}`, '1')
    } catch {
      // ignore storage errors
    }
  }

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
            <h1 className="text-2xl font-bold">Einladung nicht verfügbar</h1>
            <p className="mt-3 text-sm text-white/70">{error || 'This invitation cannot be used right now.'}</p>
            <Link to="/login" className="mt-6 inline-block text-sm text-[#58e3c7] hover:text-[#00a884]">
              Zurück zum Login
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="brand-scene min-h-screen text-white">
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-xl items-center justify-center px-6 py-10">
        <div className="brand-panel w-full rounded-[30px] p-8 sm:p-10">
          {!showVerificationScreen ? (
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

                {error ? (
                  <p className="rounded-2xl border border-red-400/20 bg-red-500/15 px-4 py-3 text-sm text-red-200">{error}</p>
                ) : null}

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full rounded-2xl bg-[#00a884] px-4 py-3 font-semibold text-[#08111a] transition hover:brightness-110 disabled:opacity-60"
                >
                  {submitting ? 'Account wird erstellt…' : 'Create Account'}
                </button>
              </form>
            </>
          ) : (
            <>
              <h1 className="text-3xl font-bold tracking-tight">E-Mail-Bestätigung erforderlich</h1>
              <p className="mt-3 text-sm text-white/70">
                Wir haben dir eine E-Mail geschickt. Bitte bestätige deine E-Mail Adresse, um fortzufahren.
              </p>
              <Link
                to="/login"
                className="mt-8 inline-flex w-full items-center justify-center rounded-2xl bg-[#00a884] px-4 py-3 font-semibold text-[#08111a] transition hover:brightness-110"
              >
                Zurück zum Login
              </Link>
              {accepted || primaryAvatarName ? (
                <p className="mt-3 text-center text-xs text-white/50">
                  Einladung aktiviert für: {primaryAvatarName || 'deine Avatare'}
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
