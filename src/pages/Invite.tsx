import { useEffect, useState, type FormEvent } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { createContactAndConversation, validateInvitationToken } from '../lib/api'

interface InviteData {
  id: string
  token: string
  active: boolean
  wa_owners: {
    id: string
    display_name: string
    avatar_url: string | null
    voice_id: string | null
    tavus_replica_id: string | null
    system_prompt?: string | null
  }
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
  const [loading, setLoading] = useState(true)
  const [invalid, setInvalid] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Contact info
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')

  const [emailSent, setEmailSent] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // --- validate token ---
  useEffect(() => {
    if (!token) {
      setInvalid(true)
      setLoading(false)
      return
    }
    validateInvitationToken(token).then((data) => {
      if (!data) {
        setInvalid(true)
      } else {
        setInvite(data as InviteData)
      }
      setLoading(false)
    })
  }, [token])

  // --- complete the invite after magic-link verification ---
  async function finalisePendingInvite(pending: PendingInvite) {
    console.log('[Invite] finalising invite for', pending.email)

    const inviteData = await validateInvitationToken(pending.token)
    if (!inviteData) {
      localStorage.removeItem(PENDING_KEY)
      setError('This invitation link is no longer active.')
      return
    }

    try {
      const { conversation } = await createContactAndConversation({
        ownerId: (inviteData as InviteData).wa_owners.id,
        invitationId: (inviteData as InviteData).id,
        firstName: pending.firstName,
        lastName: pending.lastName,
        email: pending.email,
      })
      localStorage.removeItem(PENDING_KEY)
      navigate(`/chat/${conversation.id}`)
    } catch (err) {
      console.error('[Invite] createContactAndConversation error:', err)
      localStorage.removeItem(PENDING_KEY)
      setError(err instanceof Error ? err.message : 'Unable to start the conversation.')
    }
  }

  // Handle magic-link return. Two cases:
  // 1. SIGNED_IN fires while we're mounted (listener catches it)
  // 2. Session already exists by the time we mount (race: event fired before
  //    this component rendered). We check getSession() to cover that case.
  useEffect(() => {
    let cancelled = false

    // Helper: read and validate pending data
    function readPending(): PendingInvite | null {
      const raw = localStorage.getItem(PENDING_KEY)
      if (!raw) return null
      const pending: PendingInvite = JSON.parse(raw)
      if (pending.token !== token) return null
      return pending
    }

    // Case 1 — listen for future SIGNED_IN events
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event) => {
        if (cancelled) return
        if (event !== 'SIGNED_IN') return
        const pending = readPending()
        if (!pending) return
        await finalisePendingInvite(pending)
      },
    )

    // Case 2 — session may already exist (magic-link hash was processed
    // before this component mounted)
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

  // --- send magic link ---
  async function handleSendLink(event: FormEvent) {
    event.preventDefault()
    if (!firstName.trim() || !lastName.trim() || !email.trim()) {
      setError('Enter your first name, last name, and email.')
      return
    }
    setError(null)
    setSubmitting(true)

    const redirectTo = `${window.location.origin}/invite/${token}`
    console.log('[Invite] sending magic link to', email, 'redirect →', redirectTo)

    // Persist form data so we can pick it up after the redirect
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
      },
    })

    if (otpError) {
      console.error('[Invite] magic-link error:', otpError.message, otpError)
      setError(otpError.message)
      localStorage.removeItem(PENDING_KEY)
      setSubmitting(false)
      return
    }

    setEmailSent(true)
    setSubmitting(false)
  }

  // ---------- render ----------

  if (loading) {
    return (
      <div className="brand-scene flex min-h-screen items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-[#1f2c34] border-t-[#00a884]" />
      </div>
    )
  }

  if (invalid || !invite) {
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

  const owner = invite.wa_owners

  return (
    <div className="brand-scene flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <div className="brand-panel relative z-10 w-full max-w-md rounded-[30px] p-8">
        {owner.avatar_url && (
          <img
            src={owner.avatar_url}
            alt={owner.display_name}
            className="mx-auto mb-4 h-20 w-20 rounded-full object-cover ring-4 ring-white/20"
          />
        )}

        <h1 className="text-2xl font-bold text-white">{owner.display_name}</h1>
        <p className="mt-2 text-white/60">has invited you to start a conversation</p>

        {emailSent ? (
          <div className="mt-8 space-y-4">
            <div className="rounded-2xl border border-[#00a884]/20 bg-[#00a884]/10 px-5 py-4 text-sm leading-relaxed text-[#00a884]">
              We sent a verification link to <strong>{email}</strong>.
              <br />
              Open your email and click the link to continue.
            </div>

            <button
              type="button"
              onClick={() => {
                setEmailSent(false)
                setSubmitting(false)
              }}
              className="text-sm text-white/50 underline transition hover:text-white/80"
            >
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={handleSendLink} className="mt-6 space-y-4 text-left">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="invite-first" className="mb-2 block text-sm font-medium text-white/80">
                  First Name
                </label>
                <input
                  id="invite-first"
                  type="text"
                  required
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                  placeholder="Juan"
                />
              </div>
              <div>
                <label htmlFor="invite-last" className="mb-2 block text-sm font-medium text-white/80">
                  Last Name
                </label>
                <input
                  id="invite-last"
                  type="text"
                  required
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                  placeholder="Schubert"
                />
              </div>
            </div>

            <div>
              <label htmlFor="invite-email" className="mb-2 block text-sm font-medium text-white/80">
                Email
              </label>
              <input
                id="invite-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                placeholder="you@example.com"
              />
            </div>

            {error && (
              <p className="rounded-2xl border border-red-400/15 bg-red-500/15 px-4 py-3 text-sm text-red-200">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-2xl bg-[#00a884] py-3 font-semibold text-[#0b141a] transition hover:brightness-110 disabled:opacity-50"
            >
              {submitting ? 'Sending...' : 'Send Verification Email'}
            </button>
          </form>
        )}

        {error && emailSent && (
          <p className="mt-4 rounded-2xl border border-red-400/15 bg-red-500/15 px-4 py-3 text-sm text-red-200">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
