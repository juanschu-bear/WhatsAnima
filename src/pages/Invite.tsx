import { useEffect, useState, type FormEvent } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  createContactAndConversation,
  createContactAndConversationsFromBundle,
  validateInvitationToken,
  validateBundleToken,
} from '../lib/api'

interface InviteData {
  id: string
  token: string
  active: boolean
  wa_owners: {
    id: string
    display_name: string
    voice_id: string | null
    tavus_replica_id: string | null
    system_prompt?: string | null
  }
}

interface BundleData {
  bundle: { id: string; owner_ids: string[]; label: string | null }
  owners: Array<{ id: string; display_name: string }>
}

/** Key used to persist pending invite data across the magic-link redirect. */
const PENDING_KEY = 'wa_pending_invite'

interface PendingInvite {
  token: string
  firstName: string
  lastName: string
  email: string
}

export default function Invite() {
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()

  const [invite, setInvite] = useState<InviteData | null>(null)
  const [bundleInvite, setBundleInvite] = useState<BundleData | null>(null)
  const [loading, setLoading] = useState(true)
  const [finalising, setFinalising] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Contact info
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const [authMode, setAuthMode] = useState<'password' | 'magic-link'>('password')
  const [emailSent, setEmailSent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [welcomeData, setWelcomeData] = useState<{ ownerName: string; chatId: string } | null>(null)

  // --- validate token (try bundle first, then single) ---
  useEffect(() => {
    if (!token) {
      setInvalid(true)
      setLoading(false)
      return
    }
    void (async () => {
      const bundleResult = await validateBundleToken(token)
      if (bundleResult && bundleResult.owners.length > 0) {
        setBundleInvite(bundleResult)
        setLoading(false)
        return
      }
      const singleResult = await validateInvitationToken(token)
      if (!singleResult) {
        setInvalid(true)
      } else {
        setInvite(singleResult as InviteData)
      }
      setLoading(false)
    })()
  }, [token])

  // --- If user already logged in: auto-finalise the invite immediately ---
  useEffect(() => {
    if (!invite && !bundleInvite) return
    if (finalising) return
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.user?.email) return
      const pending = localStorage.getItem(PENDING_KEY)
      if (pending) return // Let the normal pending flow handle it

      // User is already logged in — auto-finalise with their session data
      const meta = session.user.user_metadata
      const autoFirst = String(meta?.first_name || '').trim()
      const autoLast = String(meta?.last_name || '').trim()
      const autoEmail = session.user.email

      if (autoFirst && autoLast && autoEmail) {
        // All data available — finalise immediately
        setFinalising(true)
        void finalisePendingInvite({
          token: token!,
          firstName: autoFirst,
          lastName: autoLast,
          email: autoEmail,
        })
      } else {
        // Pre-fill what we have, let them complete the form
        if (autoEmail) setEmail(autoEmail)
        if (autoFirst) setFirstName(autoFirst)
        if (autoLast) setLastName(autoLast)
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invite, bundleInvite])

  // --- complete the invite ---
  async function finalisePendingInvite(pending: PendingInvite) {
    console.log('[Invite] finalising invite for', pending.email)
    setFinalising(true)

    // Try bundle first
    const bundleResult = await validateBundleToken(pending.token)
    if (bundleResult && bundleResult.owners.length > 0) {
      try {
        const result = await createContactAndConversationsFromBundle({
          bundleId: bundleResult.bundle.id,
          ownerIds: bundleResult.bundle.owner_ids,
          firstName: pending.firstName,
          lastName: pending.lastName,
          email: pending.email,
        })
        localStorage.removeItem(PENDING_KEY)
        const ownerNames = bundleResult.owners.map((o) => o.display_name).join(', ')
        const firstChatId = result.conversations[0]?.id || ''
        setWelcomeData({ ownerName: ownerNames, chatId: firstChatId })
        return
      } catch (err) {
        console.error('[Invite] bundle createContacts error:', err)
        localStorage.removeItem(PENDING_KEY)
        setError(err instanceof Error ? err.message : 'Unable to start conversations.')
        setFinalising(false)
        return
      }
    }

    // Fallback to single invite
    const inviteData = await validateInvitationToken(pending.token)
    if (!inviteData) {
      localStorage.removeItem(PENDING_KEY)
      setError('This invitation link is no longer active.')
      setFinalising(false)
      return
    }

    try {
      const ownerInfo = (inviteData as InviteData).wa_owners
      const { conversation } = await createContactAndConversation({
        ownerId: ownerInfo.id,
        invitationId: (inviteData as InviteData).id,
        firstName: pending.firstName,
        lastName: pending.lastName,
        email: pending.email,
      })
      localStorage.removeItem(PENDING_KEY)
      setWelcomeData({
        ownerName: ownerInfo.display_name,
        chatId: conversation.id,
      })
    } catch (err) {
      console.error('[Invite] createContactAndConversation error:', err)
      localStorage.removeItem(PENDING_KEY)
      setError(err instanceof Error ? err.message : 'Unable to start the conversation.')
      setFinalising(false)
    }
  }

  // Handle magic-link return or password-based sign-in completion
  useEffect(() => {
    let cancelled = false

    function readPending(): PendingInvite | null {
      const raw = localStorage.getItem(PENDING_KEY)
      if (!raw) return null
      const pending: PendingInvite = JSON.parse(raw)
      if (pending.token !== token) return null
      return pending
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event) => {
        if (cancelled) return
        if (event !== 'SIGNED_IN') return
        const pending = readPending()
        if (!pending) return
        await finalisePendingInvite(pending)
      },
    )

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) return
      if (!session) return
      const pending = readPending()
      if (!pending) return
      console.log('[Invite] session already active on mount, finalising…')
      finalisePendingInvite(pending)
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, navigate])

  // --- auto-navigate after welcome screen ---
  useEffect(() => {
    if (!welcomeData) return
    const dest = welcomeData.chatId ? `/chat/${welcomeData.chatId}` : '/avatars'
    const timer = window.setTimeout(() => {
      navigate(dest, { replace: true })
    }, 2000)
    return () => window.clearTimeout(timer)
  }, [welcomeData, navigate])

  // --- register with password (primary) ---
  async function handlePasswordSignup(event: FormEvent) {
    event.preventDefault()
    if (!firstName.trim() || !lastName.trim() || !email.trim() || !password.trim()) {
      setError('Please fill in all fields.')
      return
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.')
      return
    }
    setError(null)
    setSubmitting(true)

    // Persist form data in case we need fallback
    const pending: PendingInvite = {
      token: token!,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
    }
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending))

    // Try signUp first (new user)
    const { error: signUpError } = await supabase.auth.signUp({
      email: email.trim(),
      password: password.trim(),
      options: {
        data: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          full_name: `${firstName.trim()} ${lastName.trim()}`,
        },
      },
    })

    if (signUpError) {
      // If user already exists, try signIn
      if (signUpError.message.includes('already registered') || signUpError.message.includes('already been registered')) {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password: password.trim(),
        })
        if (signInError) {
          setError(signInError.message)
          localStorage.removeItem(PENDING_KEY)
          setSubmitting(false)
          return
        }
        // signIn succeeded — onAuthStateChange will fire and finalise
        return
      }
      setError(signUpError.message)
      localStorage.removeItem(PENDING_KEY)
      setSubmitting(false)
      return
    }

    // signUp succeeded — try immediate signIn (works when auto-confirm is enabled)
    const { error: autoSignInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password: password.trim(),
    })
    if (!autoSignInError) {
      // Signed in — onAuthStateChange will fire and finalise
      return
    }

    // signIn failed — email confirmation likely required
    const { data: { session } } = await supabase.auth.getSession()
    if (session) {
      await finalisePendingInvite(pending)
    } else {
      setEmailSent(true)
      setSubmitting(false)
    }
  }

  // --- send magic link (alternative) ---
  async function handleSendLink(event: FormEvent) {
    event.preventDefault()
    if (!firstName.trim() || !lastName.trim() || !email.trim()) {
      setError('Enter your first name, last name, and email.')
      return
    }
    setError(null)
    setSubmitting(true)

    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(`/invite/${token}`)}`

    const pending: PendingInvite = {
      token: token!,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
    }
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending))

    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        shouldCreateUser: true,
        emailRedirectTo: redirectTo,
        data: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          full_name: `${firstName.trim()} ${lastName.trim()}`,
        },
      },
    })

    if (otpError) {
      setError(otpError.message)
      localStorage.removeItem(PENDING_KEY)
      setSubmitting(false)
      return
    }

    setEmailSent(true)
    setSubmitting(false)
  }

  // ---------- render ----------

  if (loading || finalising) {
    return (
      <div className="brand-scene flex min-h-screen items-center justify-center">
        <div className="text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-[#1f2c34] border-t-[#00a884]" />
          {finalising && <p className="mt-4 text-sm text-white/60">Setting up your conversations...</p>}
        </div>
      </div>
    )
  }

  if (welcomeData) {
    const initials = welcomeData.ownerName
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase())
      .join('')
      .slice(0, 2)

    return (
      <div className="brand-scene flex min-h-screen flex-col items-center justify-center px-4 text-center">
        <div className="brand-panel relative z-10 w-full max-w-md rounded-[30px] p-8">
          <div className="mx-auto mb-4 flex h-24 w-24 items-center justify-center rounded-full bg-[linear-gradient(135deg,#0e8f74,#153f43)] text-2xl font-bold text-white ring-4 ring-[#00a884]/30 shadow-[0_0_40px_rgba(0,168,132,0.3)]">
            {initials}
          </div>
          <h1 className="text-2xl font-bold text-white">You're now connected with</h1>
          <p className="mt-2 text-xl font-semibold text-[#00a884]">{welcomeData.ownerName}</p>
          <p className="mt-4 text-sm text-white/60">Opening your conversation...</p>
          <div className="mx-auto mt-6 h-8 w-8 animate-spin rounded-full border-4 border-[#1f2c34] border-t-[#00a884]" />
        </div>
      </div>
    )
  }

  if (invalid || (!invite && !bundleInvite)) {
    return (
      <div className="brand-scene flex min-h-screen flex-col items-center justify-center px-4 text-center">
        <div className="brand-panel relative z-10 rounded-[30px] p-8">
          <h1 className="text-2xl font-bold text-white">Invalid Link</h1>
          <p className="mt-3 text-white/60">
            This invitation link is invalid or no longer active.
          </p>
          <Link
            to="/"
            className="brand-inset mt-6 inline-block rounded-2xl px-6 py-3 text-sm text-white transition hover:border-[#00a884]/60 hover:text-[#00a884]"
          >
            Go to Home
          </Link>
        </div>
      </div>
    )
  }

  const isBundleFlow = Boolean(bundleInvite)
  const bundleLabel = isBundleFlow ? bundleInvite!.bundle.label : null
  const displayTitle = isBundleFlow
    ? (bundleLabel || bundleInvite!.owners.map((o) => o.display_name).join(' & '))
    : invite!.wa_owners.display_name
  const displaySubtitle = isBundleFlow
    ? (bundleLabel
      ? `${bundleInvite!.owners.map((o) => o.display_name).join(', ')} — ${bundleInvite!.owners.length} avatars`
      : `have invited you to start ${bundleInvite!.owners.length} conversations`)
    : 'has invited you to start a conversation'

  return (
    <div className="brand-scene flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <div className="brand-panel relative z-10 w-full max-w-md rounded-[30px] p-8">
        <h1 className="text-2xl font-bold text-white">{displayTitle}</h1>
        <p className="mt-2 text-white/60">{displaySubtitle}</p>

        {emailSent ? (
          <div className="mt-8 space-y-4">
            <div className="rounded-2xl border border-[#00a884]/20 bg-[#00a884]/10 px-5 py-4 text-sm leading-relaxed text-[#00a884]">
              {authMode === 'password'
                ? <>Check your email to confirm your account, then come back here.</>
                : <>We sent a verification link to <strong>{email}</strong>. Open your email and click the link to continue.</>}
            </div>
            <button
              type="button"
              onClick={() => { setEmailSent(false); setSubmitting(false) }}
              className="text-sm text-white/50 underline transition hover:text-white/80"
            >
              Try again
            </button>
          </div>
        ) : authMode === 'password' ? (
          <form onSubmit={handlePasswordSignup} className="mt-6 space-y-4 text-left">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="invite-first" className="mb-2 block text-sm font-medium text-white/80">First Name</label>
                <input id="invite-first" type="text" required value={firstName} onChange={(e) => setFirstName(e.target.value)}
                  className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20" placeholder="Juan" />
              </div>
              <div>
                <label htmlFor="invite-last" className="mb-2 block text-sm font-medium text-white/80">Last Name</label>
                <input id="invite-last" type="text" required value={lastName} onChange={(e) => setLastName(e.target.value)}
                  className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20" placeholder="Schubert" />
              </div>
            </div>
            <div>
              <label htmlFor="invite-email" className="mb-2 block text-sm font-medium text-white/80">Email</label>
              <input id="invite-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20" placeholder="you@example.com" />
            </div>
            <div>
              <label htmlFor="invite-password" className="mb-2 block text-sm font-medium text-white/80">Password</label>
              <input id="invite-password" type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)}
                className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20" placeholder="Min. 6 characters" />
            </div>

            {error && (
              <p className="rounded-2xl border border-red-400/15 bg-red-500/15 px-4 py-3 text-sm text-red-200">{error}</p>
            )}

            <button type="submit" disabled={submitting}
              className="w-full rounded-2xl bg-[#00a884] py-3 font-semibold text-[#0b141a] transition hover:brightness-110 disabled:opacity-50">
              {submitting ? 'Creating account...' : 'Create Account & Start'}
            </button>

            <button type="button" onClick={() => { setAuthMode('magic-link'); setError(null) }}
              className="w-full text-center text-sm text-white/50 transition hover:text-white/80">
              Or sign in with magic link instead
            </button>
          </form>
        ) : (
          <form onSubmit={handleSendLink} className="mt-6 space-y-4 text-left">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="invite-first-ml" className="mb-2 block text-sm font-medium text-white/80">First Name</label>
                <input id="invite-first-ml" type="text" required value={firstName} onChange={(e) => setFirstName(e.target.value)}
                  className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20" placeholder="Juan" />
              </div>
              <div>
                <label htmlFor="invite-last-ml" className="mb-2 block text-sm font-medium text-white/80">Last Name</label>
                <input id="invite-last-ml" type="text" required value={lastName} onChange={(e) => setLastName(e.target.value)}
                  className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20" placeholder="Schubert" />
              </div>
            </div>
            <div>
              <label htmlFor="invite-email-ml" className="mb-2 block text-sm font-medium text-white/80">Email</label>
              <input id="invite-email-ml" type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20" placeholder="you@example.com" />
            </div>

            {error && (
              <p className="rounded-2xl border border-red-400/15 bg-red-500/15 px-4 py-3 text-sm text-red-200">{error}</p>
            )}

            <button type="submit" disabled={submitting}
              className="w-full rounded-2xl bg-[#00a884] py-3 font-semibold text-[#0b141a] transition hover:brightness-110 disabled:opacity-50">
              {submitting ? 'Sending...' : 'Send Verification Email'}
            </button>

            <button type="button" onClick={() => { setAuthMode('password'); setError(null) }}
              className="w-full text-center text-sm text-white/50 transition hover:text-white/80">
              Or create account with password instead
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
