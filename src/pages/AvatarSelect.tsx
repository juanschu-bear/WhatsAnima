import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { listAllOwners, findContactByEmail, findOrCreateConversation, createContactForOwner } from '../lib/api'
import { resolveAvatarUrl } from '../lib/avatars'
import { getStoredLocale, t } from '../lib/i18n'

interface OwnerOption {
  id: string
  display_name: string
}

export default function AvatarSelect() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const locale = getStoredLocale()
  const [owners, setOwners] = useState<OwnerOption[]>([])
  const [loading, setLoading] = useState(true)
  const [navigating, setNavigating] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Inline contact creation form state
  const [showForm, setShowForm] = useState(false)
  const [formOwner, setFormOwner] = useState<OwnerOption | null>(null)
  const [firstName, setFirstName] = useState(user?.user_metadata?.first_name || '')
  const [lastName, setLastName] = useState(user?.user_metadata?.last_name || '')
  const [formEmail, setFormEmail] = useState(user?.email || '')
  const [submitting, setSubmitting] = useState(false)

  function loadOwners() {
    setLoading(true)
    setError(null)
    listAllOwners()
      .then((data) => setOwners(data as OwnerOption[]))
      .catch((err) => {
        console.error('Failed to load avatars:', err)
        setError('Unable to load available avatars.')
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    loadOwners()
  }, [])

  async function selectAvatar(owner: OwnerOption) {
    if (!user?.email || navigating) return
    setNavigating(owner.id)
    setError(null)

    try {
      const contact = await findContactByEmail(user.email)
      if (!contact) {
        // No contact profile — show inline form to create one
        setFormOwner(owner)
        setShowForm(true)
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

  async function handleCreateContact(event: FormEvent) {
    event.preventDefault()
    if (!formOwner || !firstName.trim() || !lastName.trim() || !formEmail.trim()) return
    setSubmitting(true)
    setError(null)

    try {
      const contact = await createContactForOwner({
        ownerId: formOwner.id,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: formEmail.trim(),
      })
      const conversationId = await findOrCreateConversation(formOwner.id, contact.id)
      navigate(`/chat/${conversationId}`)
    } catch (err) {
      console.error('Failed to create contact:', err)
      setError(err instanceof Error ? err.message : 'Unable to create profile.')
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="brand-scene flex min-h-screen items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-[#1f2c34] border-t-[#00a884]" />
      </div>
    )
  }

  // --- Inline contact creation form ---
  if (showForm && formOwner) {
    return (
      <div className="brand-scene flex min-h-screen flex-col items-center justify-center px-4">
        <div className="brand-panel relative z-10 w-full max-w-md rounded-[30px] p-8">
          <div className="text-center">
            <img
              src={resolveAvatarUrl(formOwner.display_name)}
              alt={formOwner.display_name}
              className="mx-auto h-20 w-20 rounded-full object-cover ring-4 ring-[#00a884]/20"
            />
            <h1 className="mt-4 text-2xl font-bold text-white">{formOwner.display_name}</h1>
            <p className="mt-2 text-sm text-white/60">{t(locale, 'enterYourDetails')}</p>
          </div>

          <form onSubmit={handleCreateContact} className="mt-6 space-y-4 text-left">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="as-first" className="mb-2 block text-sm font-medium text-white/80">
                  {t(locale, 'firstName')}
                </label>
                <input
                  id="as-first"
                  type="text"
                  required
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                  placeholder="Juan"
                />
              </div>
              <div>
                <label htmlFor="as-last" className="mb-2 block text-sm font-medium text-white/80">
                  {t(locale, 'lastName')}
                </label>
                <input
                  id="as-last"
                  type="text"
                  required
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                  placeholder="Schubert"
                />
              </div>
            </div>

            <div>
              <label htmlFor="as-email" className="mb-2 block text-sm font-medium text-white/80">
                {t(locale, 'email')}
              </label>
              <input
                id="as-email"
                type="email"
                required
                value={formEmail}
                onChange={(e) => setFormEmail(e.target.value)}
                className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                placeholder="you@example.com"
              />
            </div>

            {error && (
              <p className="rounded-2xl border border-red-400/15 bg-red-500/15 px-4 py-3 text-sm text-red-200">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-2xl bg-[#00a884] py-3 font-semibold text-[#0b141a] transition hover:brightness-110 disabled:opacity-50"
            >
              {submitting ? t(locale, 'sending') : t(locale, 'startConversation')}
            </button>
          </form>

          <button
            type="button"
            onClick={() => { setShowForm(false); setFormOwner(null); setError(null) }}
            className="mt-4 block w-full text-center text-sm text-white/50 transition hover:text-white/80"
          >
            {'\u2190'} {t(locale, 'backToOptions')}
          </button>
        </div>
      </div>
    )
  }

  // --- Owner selection list ---
  return (
    <div className="brand-scene flex min-h-screen flex-col items-center justify-center px-4">
      <div className="brand-panel relative z-10 w-full max-w-lg rounded-[30px] p-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-white">{t(locale, 'chooseAvatar')}</h1>
          <p className="mt-2 text-sm text-white/60">{t(locale, 'selectWhoToTalkTo')}</p>
        </div>

        {error ? (
          <div className="mt-6 space-y-3">
            <div className="rounded-2xl border border-red-400/15 bg-red-500/15 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
            <button
              type="button"
              onClick={loadOwners}
              className="w-full rounded-2xl border border-white/10 bg-[#1f2c34]/80 px-4 py-3 text-sm font-medium text-white/70 transition hover:border-[#00a884]/60 hover:text-[#00a884]"
            >
              Retry
            </button>
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
                <img
                  src={resolveAvatarUrl(owner.display_name)}
                  alt={owner.display_name}
                  className="h-14 w-14 rounded-full object-cover ring-2 ring-white/10"
                />
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

        <div className="mt-8 flex items-center justify-center gap-6">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="text-sm text-white/50 transition hover:text-white/80"
          >
            {'\u2190'} {t(locale, 'backToOptions')}
          </button>
          <span className="text-white/20">|</span>
          <button
            type="button"
            onClick={signOut}
            className="text-sm text-white/50 transition hover:text-white/80"
          >
            {t(locale, 'signOut')}
          </button>
        </div>
      </div>
    </div>
  )
}
