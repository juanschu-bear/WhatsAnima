import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

/**
 * Route guard that requires both authentication AND owner role.
 * Verifies owner status from the database, not just localStorage.
 * Avatar-Users who navigate to /dashboard or /settings are redirected to /avatars.
 */
export default function OwnerRoute({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth()
  const [checking, setChecking] = useState(true)
  const [isOwner, setIsOwner] = useState(false)

  useEffect(() => {
    if (loading || !session) {
      setChecking(false)
      return
    }

    supabase
      .from('wa_owners')
      .select('id')
      .eq('user_id', session.user.id)
      .is('deleted_at', null)
      .maybeSingle()
      .then(({ data }) => {
        setIsOwner(!!data)
        setChecking(false)
      })
  }, [session, loading])

  if (loading || checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0b141a]">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-white border-t-transparent" />
      </div>
    )
  }

  if (!session) {
    return <Navigate to="/login" replace />
  }

  if (!isOwner) {
    return <Navigate to="/avatars" replace />
  }

  return children
}
