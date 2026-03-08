import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function Login() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    navigate('/')
  }

  return (
    <div className="brand-scene min-h-screen">
      <div className="relative z-10 flex min-h-screen items-center justify-center px-6 py-12">
        <div className="pointer-events-none absolute inset-x-0 bottom-[4vh] hidden justify-center px-6 md:flex">
          <div className="text-center">
            <div className="brand-wordmark text-[8rem] font-extrabold leading-none opacity-[0.08] lg:text-[11rem]">
              WhatsAnima
            </div>
            <div className="brand-kicker mt-2 text-lg text-white/10">
              Observational Perception Messaging
            </div>
          </div>
        </div>

        <div className="brand-panel w-full max-w-xl rounded-[34px] p-10 sm:p-12">
          <img
            src="/Icon.PNG"
            alt="WhatsAnima"
            className="mx-auto mb-6 h-24 w-auto object-contain drop-shadow-[0_0_28px_rgba(93,236,214,0.42)]"
          />
          <h1 className="mb-3 text-center text-5xl font-bold tracking-tight text-white">Sign In</h1>
          <p className="mb-8 text-center text-sm text-white/65">
            Access your WhatsAnima workspace.
          </p>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label htmlFor="email" className="mb-2 block text-sm font-medium text-white/82">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="brand-inset w-full rounded-2xl px-5 py-4 text-lg text-white placeholder-white/28 outline-none transition focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="mb-2 block text-sm font-medium text-white/82">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="brand-inset w-full rounded-2xl px-5 py-4 text-lg text-white placeholder-white/28 outline-none transition focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                placeholder="Enter your password"
              />
            </div>

            {error && (
              <p className="rounded-2xl border border-red-400/15 bg-red-500/15 px-4 py-3 text-sm text-red-200">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-2xl bg-[#00a884] py-4 text-xl font-semibold text-[#07141a] transition hover:brightness-110 disabled:opacity-50"
            >
              {loading ? 'Signing In...' : 'Sign In'}
            </button>
          </form>

          <p className="mt-7 text-center text-base text-white/60">
            No account?{' '}
            <Link to="/signup" className="font-medium text-[#00a884] hover:text-[#58e3c7]">
              Sign Up
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
