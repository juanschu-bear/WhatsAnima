import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function AuthResetPassword() {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const url = new URL(window.location.href)
      const code = url.searchParams.get('code')
      if (code) {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
        if (exchangeError) {
          setError(exchangeError.message)
          return
        }
      }

      const { data } = await supabase.auth.getSession()
      if (!data.session) {
        setError('Missing or expired reset session. Please request a new reset email.')
        return
      }
      setReady(true)
    })()
  }, [])

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!password.trim() || !confirmPassword.trim()) {
      setError('Please enter and confirm your new password.')
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
    setLoading(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setLoading(false)

    if (updateError) {
      setError(updateError.message)
      return
    }

    setMessage('Password updated successfully. Redirecting to login…')
    window.setTimeout(() => navigate('/login', { replace: true }), 1200)
  }

  return (
    <div className="brand-scene min-h-screen text-white">
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-xl items-center justify-center px-6 py-10">
        <div className="brand-panel w-full rounded-[30px] p-8 sm:p-10">
          <h1 className="text-3xl font-bold tracking-tight">Set New Password</h1>
          <p className="mt-3 text-sm text-white/70">
            Complete your password reset using the secure email verification token.
          </p>

          {!ready && !error ? (
            <div className="mt-8 flex items-center gap-3 text-sm text-white/80">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-[#00a884]" />
              Validating reset link…
            </div>
          ) : null}

          {ready ? (
            <form onSubmit={onSubmit} className="mt-8 space-y-4">
              <div>
                <label className="mb-2 block text-sm text-white/80">New password</label>
                <input
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  className="brand-inset w-full rounded-2xl px-4 py-3 text-white outline-none focus:border-[#00a884]"
                  placeholder="At least 8 characters"
                  required
                />
              </div>
              <div>
                <label className="mb-2 block text-sm text-white/80">Confirm password</label>
                <input
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  type="password"
                  className="brand-inset w-full rounded-2xl px-4 py-3 text-white outline-none focus:border-[#00a884]"
                  placeholder="Repeat your password"
                  required
                />
              </div>
              {message ? (
                <p className="rounded-2xl border border-[#00a884]/35 bg-[#00a884]/10 px-4 py-3 text-sm text-[#89f6e2]">
                  {message}
                </p>
              ) : null}
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-2xl bg-[#00a884] px-4 py-3 font-semibold text-[#08111a] transition hover:brightness-110 disabled:opacity-60"
              >
                {loading ? 'Updating…' : 'Update Password'}
              </button>
            </form>
          ) : null}

          {error ? (
            <p className="mt-6 rounded-2xl border border-red-400/20 bg-red-500/15 px-4 py-3 text-sm text-red-200">{error}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
