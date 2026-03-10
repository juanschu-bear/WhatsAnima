import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { listAllOwners, findContactByEmail, findOrCreateConversation } from '../lib/api'

interface OwnerOption {
  id: string
  display_name: string
  avatar_url: string | null
}

function getInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase())
    .join('')
    .slice(0, 2)
}

export default function AvatarSelect() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [owners, setOwners] = useState<OwnerOption[]>([])
  const [loading, setLoading] = useState(true)
  const [navigating, setNavigating] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listAllOwners()
      .then((data) => setOwners(data as OwnerOption[]))
      .catch((err) => {
        console.error('Failed to load avatars:', err)
        setError('Unable to load available avatars.')
      })
      .finally(() => setLoading(false))
  }, [])

  async function selectAvatar(owner: OwnerOption) {
    if (!user?.email || navigating) return
    setNavigating(owner.id)
    setError(null)

    try {
      const contact = await findContactByEmail(user.email)
      if (!contact) {
        setError('Your contact profile was not found. Please use an invitation link first.')
        setNavigating(null)
        return
      }

      const conversationId = await findOrCreateConversation(owner.id, contact.id)
      navigate(`/chat/${conversationId}`)
    } catch (err) {
      console.error('Failed to start conversation:', err)
      setError(err instanceof Error ? err.message : 'Unable to start conversation.')
      setNavigating(null)
    }
  }

  if (loading) {
    return (
      <div className="brand-scene flex min-h-screen items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-[#1f2c34] border-t-[#00a884]" />
      </div>
    )
  }

  return (
    <div className="brand-scene flex min-h-screen flex-col items-center justify-center px-4">
      <div className="brand-panel relative z-10 w-full max-w-lg rounded-[30px] p-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-white">Choose an Avatar</h1>
          <p className="mt-2 text-sm text-white/60">Select who you'd like to talk to</p>
        </div>

        {error ? (
          <div className="mt-6 rounded-2xl border border-red-400/15 bg-red-500/15 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        <div className="mt-8 space-y-3">
          {owners.map((owner) => (
            <button
              key={owner.id}
              type="button"
              onClick={() => selectAvatar(owner)}
              disabled={navigating !== null}
              className={`w-full rounded-[24px] border px-5 py-5 text-left transition duration-200 ${
                navigating === owner.id
                  ? 'border-[#00a884]/55 bg-[linear-gradient(180deg,rgba(8,55,52,0.88),rgba(7,36,35,0.94))] shadow-[0_16px_40px_rgba(0,0,0,0.22)]'
                  : 'border-white/6 bg-[rgba(8,22,30,0.7)] hover:-translate-y-[1px] hover:border-[#00a884]/45 hover:bg-[rgba(10,27,37,0.8)]'
              } disabled:opacity-60`}
            >
              <div className="flex items-center gap-4">
                {owner.avatar_url ? (
                  <img
                    src={owner.avatar_url}
                    alt={owner.display_name}
                    className="h-14 w-14 rounded-full object-cover ring-2 ring-white/10"
                  />
                ) : (
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[linear-gradient(135deg,#0e8f74,#153f43)] text-lg font-semibold text-white ring-2 ring-white/10">
                    {getInitials(owner.display_name)}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-lg font-semibold text-white">{owner.display_name}</p>
                  <div className="mt-1 flex items-center gap-2 text-sm text-white/50">
                    <span className="h-2 w-2 rounded-full bg-[#00a884]" />
                    <span>Online</span>
                  </div>
                </div>
                {navigating === owner.id ? (
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-[#1f2c34] border-t-[#00a884]" />
                ) : (
                  <svg className="h-5 w-5 text-white/30" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                )}
              </div>
            </button>
          ))}

          {owners.length === 0 ? (
            <div className="rounded-[24px] border border-white/6 bg-black/14 px-4 py-8 text-center text-sm text-white/58">
              No avatars available yet.
            </div>
          ) : null}
        </div>

        <div className="mt-8 flex justify-center">
          <button
            type="button"
            onClick={signOut}
            className="text-sm text-white/50 transition hover:text-white/80"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}
