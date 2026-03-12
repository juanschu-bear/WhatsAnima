import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

/**
 * Handles the redirect after a magic link click.
 * With PKCE flow, Supabase appends ?code=xxx to the redirect URL.
 * This page exchanges the code for a session, then navigates to the app.
 */
export default function AuthCallback() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const url = new URL(window.location.href)
    const code = url.searchParams.get('code')
    const next = url.searchParams.get('next') || '/'

    if (code) {
      supabase.auth.exchangeCodeForSession(code).then(({ error: authError }) => {
        if (authError) {
          console.error('[AuthCallback] Code exchange failed:', authError.message)
          setError(authError.message)
          return
        }
        navigate(next, { replace: true })
      })
    } else {
      // No code — maybe a hash-based redirect (legacy). Let Supabase handle it.
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session) {
          navigate(next, { replace: true })
        } else {
          navigate('/login', { replace: true })
        }
      })
    }
  }, [navigate])

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#0b141a] text-white">
        <p className="text-red-400">Login failed: {error}</p>
        <button
          className="mt-4 rounded-lg bg-[#00a884] px-6 py-2 text-white"
          onClick={() => navigate('/login', { replace: true })}
        >
          Back to Login
        </button>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0b141a]">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-[#00a884]" />
    </div>
  )
}
