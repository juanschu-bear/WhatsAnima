import { useEffect, useState } from 'react'
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

  useEffect(() => {
    if (!user) return
    createOwnerIfNeeded(user.id, user.email ?? 'Owner').then((owner) => {
      setOwnerId(owner.id)
      return listInvitationLinks(owner.id)
    }).then((data) => {
      setLinks(data as InvitationLink[])
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
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-purple-600 to-blue-500">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-white border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-600 to-blue-500 px-4 py-8">
      <div className="mx-auto max-w-3xl">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <h1 className="text-3xl font-bold text-white">Dashboard</h1>
          <button
            onClick={signOut}
            className="rounded-lg border border-white/30 px-4 py-2 text-sm text-white transition hover:bg-white/10"
          >
            Abmelden
          </button>
        </div>

        {/* Generate new link */}
        <div className="mb-8 rounded-2xl bg-white/10 p-6 backdrop-blur-md">
          <h2 className="mb-4 text-lg font-semibold text-white">Neuen Einladungslink erstellen</h2>
          <div className="flex gap-3">
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (optional)"
              className="flex-1 rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-white placeholder-white/40 outline-none focus:border-white/50 focus:ring-2 focus:ring-white/20"
            />
            <button
              onClick={handleGenerate}
              className="rounded-lg bg-white px-6 py-2 font-semibold text-purple-700 transition hover:bg-white/90"
            >
              Erstellen
            </button>
          </div>
        </div>

        {/* Links list */}
        <div className="rounded-2xl bg-white/10 p-6 backdrop-blur-md">
          <h2 className="mb-4 text-lg font-semibold text-white">Einladungslinks</h2>

          {links.length === 0 ? (
            <p className="text-center text-white/60">Noch keine Links erstellt.</p>
          ) : (
            <div className="space-y-3">
              {links.map((link) => (
                <div
                  key={link.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white/5 p-4"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-white">
                      {link.label || 'Kein Label'}
                    </p>
                    <p className="mt-1 truncate text-xs text-white/50">
                      /invite/{link.token.slice(0, 8)}...
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className="whitespace-nowrap text-xs text-white/60">
                      {link.use_count} Nutzungen
                    </span>

                    <button
                      onClick={() => handleToggle(link.id, link.active)}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                        link.active
                          ? 'bg-green-500/20 text-green-300 hover:bg-green-500/30'
                          : 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
                      }`}
                    >
                      {link.active ? 'Aktiv' : 'Inaktiv'}
                    </button>

                    <button
                      onClick={() => copyLink(link.token, link.id)}
                      className="rounded-lg border border-white/20 px-3 py-1 text-xs text-white transition hover:bg-white/10"
                    >
                      {copiedId === link.id ? 'Kopiert!' : 'Link kopieren'}
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
