import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function Login() {
  const navigate = useNavigate()
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [otpCode, setOtpCode] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleRequestOtp = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setLoading(true)

    const { error } = await supabase.auth.signInWithOtp({
      phone: phoneNumber,
      options: {
        shouldCreateUser: false,
      },
    })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    setOtpSent(true)
    setLoading(false)
  }

  const handleVerifyOtp = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setLoading(true)

    const { error } = await supabase.auth.verifyOtp({
      phone: phoneNumber,
      token: otpCode,
      type: 'sms',
    })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    navigate('/')
  }

  return (
    <div className="brand-scene min-h-screen">
      <div className="relative z-10 flex min-h-screen items-start justify-center px-6 pb-24 pt-12 sm:pt-16 md:pt-20">
        <div className="brand-panel w-full max-w-md rounded-[32px] p-7 sm:p-8">
          <img
            src="/Icon.PNG"
            alt="WhatsAnima"
            className="mx-auto mb-4 h-16 w-auto object-contain drop-shadow-[0_0_22px_rgba(93,236,214,0.34)]"
          />
          <h1 className="mb-2 text-center text-4xl font-bold tracking-tight text-white">Sign In</h1>
          <p className="mb-6 text-center text-sm text-white/65">
            Sign in with your phone number and SMS code.
          </p>

          <form onSubmit={otpSent ? handleVerifyOtp : handleRequestOtp} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="first-name" className="mb-2 block text-sm font-medium text-white/82">
                  First name
                </label>
                <input
                  id="first-name"
                  type="text"
                  required
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                  className="brand-inset w-full rounded-2xl px-4 py-3.5 text-white placeholder-white/28 outline-none transition focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                  placeholder="Juan"
                />
              </div>

              <div>
                <label htmlFor="last-name" className="mb-2 block text-sm font-medium text-white/82">
                  Last name
                </label>
                <input
                  id="last-name"
                  type="text"
                  required
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                  className="brand-inset w-full rounded-2xl px-4 py-3.5 text-white placeholder-white/28 outline-none transition focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                  placeholder="Schubert"
                />
              </div>
            </div>

            <div>
              <label htmlFor="phone" className="mb-2 block text-sm font-medium text-white/82">
                Phone number
              </label>
              <input
                id="phone"
                type="tel"
                required
                value={phoneNumber}
                onChange={(event) => setPhoneNumber(event.target.value)}
                className="brand-inset w-full rounded-2xl px-4 py-3.5 text-white placeholder-white/28 outline-none transition focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                placeholder="+49 1512 3456789"
              />
            </div>

            {otpSent ? (
              <div>
                <label htmlFor="otp-code" className="mb-2 block text-sm font-medium text-white/82">
                  SMS code
                </label>
                <input
                  id="otp-code"
                  type="text"
                  inputMode="numeric"
                  required
                  value={otpCode}
                  onChange={(event) => setOtpCode(event.target.value)}
                  className="brand-inset w-full rounded-2xl px-4 py-3.5 text-white placeholder-white/28 outline-none transition focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                  placeholder="123456"
                />
              </div>
            ) : null}

            {error ? (
              <p className="rounded-2xl border border-red-400/15 bg-red-500/15 px-4 py-3 text-sm text-red-200">
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-2xl bg-[#00a884] py-3.5 text-lg font-semibold text-[#07141a] transition hover:brightness-110 disabled:opacity-50"
            >
              {loading ? 'Working...' : otpSent ? 'Verify Code' : 'Send SMS Code'}
            </button>
          </form>

          <p className="mt-6 text-center text-base text-white/60">
            Need an account?{' '}
            <Link to="/signup" className="font-medium text-[#00a884] hover:text-[#58e3c7]">
              Sign Up
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
