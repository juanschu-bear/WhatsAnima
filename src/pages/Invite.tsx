import { useEffect, useMemo, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { createContactAndConversation, validateInvitationToken } from '../lib/api'
import { supabase } from '../lib/supabase'

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
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [otpCode, setOtpCode] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [otpVerified, setOtpVerified] = useState(false)
  const [sendingOtp, setSendingOtp] = useState(false)
  const [verifyingOtp, setVerifyingOtp] = useState(false)

  const normalizedPhoneNumber = useMemo(() => phoneNumber.replace(/\s+/g, ''), [phoneNumber])

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

  async function handleSendOtp() {
    if (!invite) return
    if (!firstName.trim() || !lastName.trim() || !normalizedPhoneNumber) {
      setError('Enter your first name, last name, and phone number.')
      return
    }

    setSendingOtp(true)
    setError(null)
    try {
      const { error: otpError } = await supabase.auth.signInWithOtp({
        phone: normalizedPhoneNumber,
        options: {
          shouldCreateUser: true,
        },
      })
      if (otpError) throw otpError
      setOtpSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to send the verification code.')
    } finally {
      setSendingOtp(false)
    }
  }

  async function handleVerifyOtp() {
    if (!normalizedPhoneNumber || !otpCode.trim()) {
      setError('Enter the verification code from SMS.')
      return
    }

    setVerifyingOtp(true)
    setError(null)
    try {
      const { error: verifyError } = await supabase.auth.verifyOtp({
        phone: normalizedPhoneNumber,
        token: otpCode.trim(),
        type: 'sms',
      })
      if (verifyError) throw verifyError
      setOtpVerified(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to verify the code.')
    } finally {
      setVerifyingOtp(false)
    }
  }

  async function handleStart() {
    if (!invite || !otpVerified) return
    setStarting(true)
    setError(null)
    try {
      const { conversation } = await createContactAndConversation({
        ownerId: invite.wa_owners.id,
        invitationId: invite.id,
        firstName,
        lastName,
        phoneNumber: normalizedPhoneNumber,
      })
      navigate(`/chat/${conversation.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start the conversation.')
    } finally {
      setStarting(false)
    }
  }

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

        {error && (
          <p className="mt-6 rounded-2xl border border-red-400/15 bg-red-500/15 px-4 py-3 text-sm text-red-200">
            {error}
          </p>
        )}

        <div className="mt-8 space-y-4 text-left">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-2 block text-sm font-medium text-white/80">First Name</label>
              <input
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="Juan"
                className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
              />
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium text-white/80">Last Name</label>
              <input
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Schubert"
                className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
              />
            </div>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-white/80">Phone Number</label>
            <input
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="+491701234567"
              className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
            />
          </div>

          {!otpSent ? (
            <button
              onClick={handleSendOtp}
              disabled={sendingOtp}
              className="w-full rounded-2xl bg-[#00a884] py-3 font-semibold text-[#0b141a] transition hover:brightness-110 disabled:opacity-50"
            >
              {sendingOtp ? 'Sending Code...' : 'Send Verification Code'}
            </button>
          ) : (
            <>
              <div>
                <label className="mb-2 block text-sm font-medium text-white/80">SMS Code</label>
                <input
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value)}
                  placeholder="123456"
                  className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                />
              </div>

              {!otpVerified ? (
                <button
                  onClick={handleVerifyOtp}
                  disabled={verifyingOtp}
                  className="w-full rounded-2xl bg-[#00a884] py-3 font-semibold text-[#0b141a] transition hover:brightness-110 disabled:opacity-50"
                >
                  {verifyingOtp ? 'Verifying...' : 'Verify Phone Number'}
                </button>
              ) : (
                <button
                  onClick={handleStart}
                  disabled={starting}
                  className="w-full rounded-2xl bg-[#00a884] py-3 font-semibold text-[#0b141a] transition hover:brightness-110 disabled:opacity-50"
                >
                  {starting ? 'Starting...' : 'Start Conversation'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
