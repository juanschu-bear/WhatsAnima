import { useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { validateInvitationToken, createContactAndConversation } from '../lib/api'

interface InviteData {
  id: string
  token: string
  active: boolean
  wa_owners: { id: string; display_name: string; avatar_url: string | null }
}

export default function Invite() {
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const [invite, setInvite] = useState<InviteData | null>(null)
  const [loading, setLoading] = useState(true)
  const [invalid, setInvalid] = useState(false)
  const [starting, setStarting] = useState(false)

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

  async function handleStart() {
    if (!invite) return
    setStarting(true)
    try {
      const { conversation } = await createContactAndConversation(
        invite.wa_owners.id,
        invite.id,
        'Guest'
      )
      navigate(`/chat/${conversation.id}`)
    } catch {
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

        <button
          onClick={handleStart}
          disabled={starting}
          className="mt-8 w-full rounded-2xl bg-[#00a884] py-3 font-semibold text-[#0b141a] transition hover:brightness-110 disabled:opacity-50"
        >
          {starting ? 'Starting...' : 'Start Conversation'}
        </button>
      </div>
    </div>
  )
}
