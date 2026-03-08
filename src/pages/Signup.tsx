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
    <div className="flex min-h-screen items-center justify-center bg-[#0b141a] px-4">
      <div className="w-full max-w-md">
        <img
          src="/hero.png"
          alt="WhatsAnima"
          className="mx-auto mb-6 max-w-[400px] w-full"
        />
        <h1 className="mb-6 text-center text-3xl font-bold text-white">Registrieren</h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-white/80">
              E-Mail
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-white placeholder-white/40 outline-none focus:border-white/50 focus:ring-2 focus:ring-white/20"
              placeholder="deine@email.de"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-white/80">
              Passwort
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-white placeholder-white/40 outline-none focus:border-white/50 focus:ring-2 focus:ring-white/20"
              placeholder="Mindestens 6 Zeichen"
            />
          </div>

          {error && (
            <p className="rounded-lg bg-red-500/20 px-4 py-2 text-sm text-red-200">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-white py-2.5 font-semibold text-[#0b141a] transition hover:bg-white/90 disabled:opacity-50"
          >
            {loading ? 'Wird erstellt...' : 'Account erstellen'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-white/60">
          Bereits registriert?{' '}
          <Link to="/login" className="text-white underline hover:text-white/80">
            Anmelden
          </Link>
        </p>
      </div>
    </div>
  )
}
