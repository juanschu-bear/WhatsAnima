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

  // OTP flow state
  const [otpCode, setOtpCode] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [submitting, setSubmitting] = useState(false)

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

  async function handleRequestOtp(event: FormEvent) {
    event.preventDefault()
    if (!firstName.trim() || !lastName.trim() || !email.trim()) {
      setError('Enter your first name, last name, and email.')
      return
    }
    setError(null)
    setSubmitting(true)

    console.log('[Invite] requesting email OTP for', email)

    const { data, error: otpError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: true },
    })

    console.log('[Invite] signInWithOtp response', { data, error: otpError })

    if (otpError) {
      console.error('[Invite] OTP error:', otpError.message, otpError)
      setError(otpError.message)
      setSubmitting(false)
      return
    }

    setOtpSent(true)
    setSubmitting(false)
  }

  async function handleVerifyAndStart(event: FormEvent) {
    event.preventDefault()
    if (!invite) return
    setError(null)
    setSubmitting(true)

    console.log('[Invite] verifying email OTP for', email)

    const { data: verifyData, error: verifyError } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: otpCode,
      type: 'email',
    })

    console.log('[Invite] verifyOtp response', { data: verifyData, error: verifyError })

    if (verifyError) {
      console.error('[Invite] verify error:', verifyError.message, verifyError)
      setError(verifyError.message)
      setSubmitting(false)
      return
    }

    // OTP verified — create the contact and conversation
    try {
      const { conversation } = await createContactAndConversation({
        ownerId: invite.wa_owners.id,
        invitationId: invite.id,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
      })
      navigate(`/chat/${conversation.id}`)
    } catch (err) {
      console.error('[Invite] createContactAndConversation error:', err)
      setError(err instanceof Error ? err.message : 'Unable to start the conversation.')
      setSubmitting(false)
    }
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

        <form
          onSubmit={otpSent ? handleVerifyAndStart : handleRequestOtp}
          className="mt-6 space-y-4 text-left"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="invite-first" className="mb-2 block text-sm font-medium text-white/80">
                First Name
              </label>
              <input
                id="invite-first"
                type="text"
                required
                disabled={otpSent}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20 disabled:opacity-50"
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
                disabled={otpSent}
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20 disabled:opacity-50"
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
              disabled={otpSent}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20 disabled:opacity-50"
              placeholder="you@example.com"
            />
          </div>

          {otpSent && (
            <>
              <p className="rounded-2xl border border-[#00a884]/20 bg-[#00a884]/10 px-4 py-3 text-sm text-[#00a884]">
                Check your email for the verification code.
              </p>
              <div>
                <label htmlFor="invite-otp" className="mb-2 block text-sm font-medium text-white/80">
                  Verification Code
                </label>
                <input
                  id="invite-otp"
                  type="text"
                  inputMode="numeric"
                  required
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value)}
                  className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                  placeholder="123456"
                />
              </div>
            </>
          )}

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
            {submitting
              ? 'Working...'
              : otpSent
                ? 'Verify & Start Conversation'
                : 'Send Verification Code'}
          </button>
        </form>
      </div>
    </div>
  )
}
