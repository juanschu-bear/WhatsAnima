import { Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

/**
 * Route guard that requires both authentication AND owner login role.
 * Avatar-Users who navigate to /dashboard or /settings are redirected to /avatars.
 */
export default function OwnerRoute({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0b141a]">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-white border-t-transparent" />
      </div>
    )
  }

  if (!session) {
    return <Navigate to="/login" replace />
  }

  const loginRole = localStorage.getItem('wa_login_role')
  if (loginRole === 'user') {
    return <Navigate to="/avatars" replace />
  }

  return children
}
