import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function Signup() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const { error } = await supabase.auth.signUp({ email, password })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    navigate('/')
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0b141a] px-6 py-12">
      <div className="w-full max-w-md rounded-[28px] border border-white/10 bg-[#1f2c34] p-8 shadow-2xl shadow-black/30">
        <img
          src="/Icon.PNG"
          alt="WhatsAnima"
          className="mx-auto mb-4 h-14 w-14 object-contain"
        />
        <h1 className="mb-2 text-center text-3xl font-bold text-white">Sign Up</h1>
        <p className="mb-8 text-center text-sm text-white/65">Create your WhatsAnima account.</p>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-white/80">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-2xl border border-white/10 bg-[#0f1b22] px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-white/80">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-2xl border border-white/10 bg-[#0f1b22] px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
              placeholder="At least 6 characters"
            />
          </div>

          {error && (
            <p className="rounded-lg bg-red-500/20 px-4 py-2 text-sm text-red-200">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-2xl bg-[#00a884] py-3 font-semibold text-[#0b141a] transition hover:brightness-110 disabled:opacity-50"
          >
            {loading ? 'Signing Up...' : 'Sign Up'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-white/60">
          Already have an account?{' '}
          <Link to="/login" className="text-[#00a884] hover:text-[#33c3a4]">
            Sign In
          </Link>
        </p>
      </div>
    </div>
  )
}
