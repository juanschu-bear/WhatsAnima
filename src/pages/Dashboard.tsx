import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import {
  createOwnerIfNeeded,
  generateInvitationLink,
  listInvitationLinks,
  toggleInvitationLink,
} from '../lib/api'

interface InvitationLink {
  id: string
  token: string
  label: string | null
  use_count: number
  active: boolean
  created_at: string
}

export default function Dashboard() {
  const { user, signOut } = useAuth()
  const [ownerId, setOwnerId] = useState<string | null>(null)
  const [links, setLinks] = useState<InvitationLink[]>([])
  const [label, setLabel] = useState('')
  const [loading, setLoading] = useState(true)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!user) {
      setLoading(false)
      return
    }

    setLoading(true)
    createOwnerIfNeeded(user.id, user.email ?? 'Owner')
      .then((owner) => {
        setOwnerId(owner.id)
        return listInvitationLinks(owner.id)
      })
      .then((data) => {
        setLinks(data as InvitationLink[])
        setError(null)
      })
      .catch((err) => {
        console.error('Dashboard load error:', err)
        setError('Unable to load invitation links. Please check your Supabase connection.')
      })
      .finally(() => {
        setLoading(false)
      })
  }, [user])

  const handleGenerate = async () => {
    if (!ownerId) return
    const link = await generateInvitationLink(ownerId, label || undefined)
    setLinks((prev) => [link as InvitationLink, ...prev])
    setLabel('')
  }

  const handleToggle = async (linkId: string, currentActive: boolean) => {
    await toggleInvitationLink(linkId, !currentActive)
    setLinks((prev) =>
      prev.map((l) => (l.id === linkId ? { ...l, active: !currentActive } : l))
    )
  }

  const copyLink = (token: string, id: string) => {
    const url = `${window.location.origin}/invite/${token}`
    navigator.clipboard.writeText(url)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0b141a]">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-[#1f2c34] border-t-[#00a884]" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#0b141a] px-6 py-8 text-white">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 flex flex-col gap-4 rounded-[28px] border border-white/10 bg-[#1f2c34] p-6 shadow-xl shadow-black/20 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <img src="/Icon.PNG" alt="WhatsAnima" className="h-10 w-10 shrink-0 object-contain" />
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-white/45">WhatsAnima</p>
              <h1 className="text-3xl font-bold text-white">Dashboard</h1>
              <p className="mt-1 text-sm text-white/60">{user?.email}</p>
            </div>
          </div>
          <div className="flex gap-3">
            <Link
              to="/"
              className="rounded-2xl border border-white/10 bg-[#0f1b22] px-5 py-3 text-sm font-medium transition hover:border-[#00a884]/60 hover:text-[#00a884]"
            >
              Home
            </Link>
            <button
              onClick={signOut}
              className="rounded-2xl bg-[#00a884] px-5 py-3 text-sm font-semibold text-[#0b141a] transition hover:brightness-110"
            >
              Sign Out
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-8 rounded-[28px] border border-red-400/20 bg-red-500/10 p-6 text-center">
            <p className="text-red-300">{error}</p>
          </div>
        )}

        <div className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr]">
          <section className="rounded-[28px] border border-white/10 bg-[#1f2c34] p-6 shadow-xl shadow-black/20">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/45">Invitations</p>
                <h2 className="mt-2 text-2xl font-semibold text-white">Generate a New Link</h2>
                <p className="mt-2 text-sm text-white/60">
                  Create invitation links and share them with new contacts.
                </p>
              </div>
              <button
                onClick={handleGenerate}
                className="rounded-2xl bg-[#00a884] px-5 py-3 text-sm font-semibold text-[#0b141a] transition hover:brightness-110"
              >
                Generate Link
              </button>
            </div>

            <div className="mt-6">
              <label htmlFor="invite-label" className="mb-2 block text-sm font-medium text-white/80">
                Label
              </label>
              <input
                id="invite-label"
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Optional team or campaign name"
                className="w-full rounded-2xl border border-white/10 bg-[#0f1b22] px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
              />
            </div>
          </section>

          <section className="rounded-[28px] border border-white/10 bg-[#1f2c34] p-6 shadow-xl shadow-black/20">
            <p className="text-xs uppercase tracking-[0.24em] text-white/45">Overview</p>
            <h2 className="mt-2 text-2xl font-semibold text-white">Invitation Links</h2>
            <p className="mt-2 text-sm text-white/60">
              Active links stay available until you disable them.
            </p>
            <div className="mt-6 rounded-3xl border border-white/10 bg-[#0f1b22] px-5 py-6">
              <p className="text-4xl font-bold text-white">{links.length}</p>
              <p className="mt-2 text-sm text-white/60">total links created</p>
            </div>
          </section>
        </div>

        <div className="mt-8 rounded-[28px] border border-white/10 bg-[#1f2c34] p-6 shadow-xl shadow-black/20">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-white/45">List</p>
              <h2 className="mt-2 text-2xl font-semibold text-white">Invitation Links</h2>
            </div>
            <p className="text-sm text-white/55">{links.length} link{links.length === 1 ? '' : 's'}</p>
          </div>

          {links.length === 0 ? (
            <div className="mt-6 rounded-2xl border border-dashed border-white/10 bg-[#0f1b22] px-4 py-8 text-center text-white/60">
              No invitation links yet.
            </div>
          ) : (
            <div className="mt-6 space-y-3">
              {links.map((link) => (
                <div
                  key={link.id}
                  className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-[#0f1b22] p-4 lg:flex-row lg:items-center lg:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-white">
                      {link.label || 'Untitled invite'}
                    </p>
                    <p className="mt-2 truncate font-mono text-xs text-white/50">
                      {window.location.origin}/invite/{link.token}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <span className="whitespace-nowrap rounded-full border border-white/10 px-3 py-1 text-xs text-white/60">
                      {link.use_count} uses
                    </span>

                    <button
                      onClick={() => handleToggle(link.id, link.active)}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                        link.active
                          ? 'bg-[#00a884]/20 text-[#7be3ce] hover:bg-[#00a884]/30'
                          : 'bg-white/10 text-white/60 hover:bg-white/15'
                      }`}
                    >
                      {link.active ? 'Active' : 'Inactive'}
                    </button>

                    <button
                      onClick={() => copyLink(link.token, link.id)}
                      className="rounded-xl border border-white/10 px-4 py-2 text-xs text-white transition hover:border-[#00a884]/60 hover:text-[#00a884]"
                    >
                      {copiedId === link.id ? 'Copied!' : 'Copy Link'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
