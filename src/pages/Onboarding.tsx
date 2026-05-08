import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import {
  createContactForOwner,
  findContactByEmailForOwner,
  findOrCreateConversation,
  requestOutboundCall,
} from '../lib/api'
import { resolveAvatarUrl } from '../lib/avatars'
import { supabase } from '../lib/supabase'

type OnboardingAvatar = {
  ownerId: string
  avatarName: string
}

export default function Onboarding() {
  const navigate = useNavigate()
  const { user } = useAuth()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [avatars, setAvatars] = useState<OnboardingAvatar[]>([])
  const [busyAvatar, setBusyAvatar] = useState<string | null>(null)

  const inviteCode = String(user?.user_metadata?.invite_code || '').trim()
  const inviteeName = String(user?.user_metadata?.invitee_name || '').trim()
  const inviteLanguage = String(user?.user_metadata?.language || 'en').trim().toLowerCase() || 'en'

  const welcomeName = useMemo(() => {
    if (inviteeName) return inviteeName
    const firstName = String(user?.user_metadata?.first_name || '').trim()
    if (firstName) return firstName
    const fallback = String(user?.email || '').split('@')[0].trim()
    return fallback || 'there'
  }, [inviteeName, user?.email, user?.user_metadata?.first_name])

  useEffect(() => {
    if (!user) {
      navigate('/login', { replace: true })
      return
    }

    if (!inviteCode) {
      navigate('/signup', { replace: true })
      return
    }

    let cancelled = false
    void (async () => {
      setLoading(true)
      setError(null)
      try {
        const { data: accessRows, error: accessError } = await supabase
          .from('wa_user_avatar_access')
          .select('owner_id, avatar_name')
          .eq('user_id', user.id)
          .is('revoked_at', null)

        if (accessError) throw accessError

        const ownerIds = Array.from(
          new Set((accessRows ?? []).map((row) => String(row.owner_id || '').trim()).filter(Boolean)),
        )

        let ownerRows: Array<{ id: string; display_name: string | null }> = []
        if (ownerIds.length > 0) {
          const { data: owners, error: ownerError } = await supabase
            .from('wa_owners')
            .select('id, display_name')
            .in('id', ownerIds)
            .is('deleted_at', null)

          if (ownerError) throw ownerError
          ownerRows = (owners || []) as Array<{ id: string; display_name: string | null }>
        }

        const ownerNameById = new Map<string, string>()
        for (const owner of ownerRows) {
          const ownerId = String(owner.id || '').trim()
          const ownerName = String(owner.display_name || '').trim()
          if (ownerId && ownerName) ownerNameById.set(ownerId, ownerName)
        }

        const normalized: OnboardingAvatar[] = []
        const seen = new Set<string>()
        for (const row of accessRows || []) {
          const ownerId = String(row.owner_id || '').trim()
          const fallbackName = String(row.avatar_name || '').trim()
          const avatarName = ownerNameById.get(ownerId) || fallbackName
          if (!ownerId || !avatarName) continue
          const key = `${ownerId}::${avatarName}`
          if (seen.has(key)) continue
          seen.add(key)
          normalized.push({ ownerId, avatarName })
        }

        if (!cancelled) {
          setAvatars(normalized)
          if (normalized.length === 0) {
            setError('Für dein Konto wurden noch keine Avatare freigeschaltet.')
          }
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Onboarding konnte nicht geladen werden.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [inviteCode, navigate, user])

  async function ensureConversation(ownerId: string) {
    if (!user?.email) throw new Error('User email missing')

    const existingContact = await findContactByEmailForOwner(ownerId, user.email)
    if (existingContact?.id) {
      return findOrCreateConversation(ownerId, existingContact.id)
    }

    const firstName = String(user.user_metadata?.first_name || '').trim() || welcomeName
    const lastName = String(user.user_metadata?.last_name || '').trim() || 'User'
    const createdContact = await createContactForOwner({
      ownerId,
      firstName,
      lastName,
      email: user.email,
    })

    return findOrCreateConversation(ownerId, createdContact.id)
  }

  async function handleStartChat(avatar: OnboardingAvatar) {
    if (!user || busyAvatar) return
    setBusyAvatar(avatar.ownerId)
    setError(null)
    try {
      const conversationId = await ensureConversation(avatar.ownerId)
      navigate(`/chat/${conversationId}`)
    } catch (chatError) {
      setError(chatError instanceof Error ? chatError.message : 'Chat konnte nicht gestartet werden.')
      setBusyAvatar(null)
    }
  }

  async function handleStartOnboardingCall(avatar: OnboardingAvatar) {
    if (!user || !user.email || busyAvatar) return
    setBusyAvatar(avatar.ownerId)
    setError(null)
    try {
      const conversationId = await ensureConversation(avatar.ownerId)

      const { data: conversationRow, error: convError } = await supabase
        .from('wa_conversations')
        .select('contact_id')
        .eq('id', conversationId)
        .maybeSingle()
      if (convError) throw convError
      const contactId = String(conversationRow?.contact_id || '').trim()
      if (!contactId) throw new Error('Kontakt konnte nicht bestimmt werden.')

      await requestOutboundCall({
        conversationId,
        ownerId: avatar.ownerId,
        contactId,
        userId: user.id,
        contactEmail: user.email,
        triggerText: 'onboarding_first_call',
        language: inviteLanguage,
        callerDisplayName: avatar.avatarName,
      })

      navigate(`/video-call/${conversationId}`)
    } catch (callError) {
      setError(callError instanceof Error ? callError.message : 'Onboarding Call konnte nicht gestartet werden.')
      setBusyAvatar(null)
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
    <div className="brand-scene min-h-screen text-white">
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-4xl flex-col px-6 py-10">
        <div className="brand-panel rounded-[30px] p-8 sm:p-10">
          <h1 className="text-3xl font-bold tracking-tight">Willkommen, {welcomeName}!</h1>
          <p className="mt-2 text-sm text-white/70">Deine Avatare sind bereit.</p>

          {error ? (
            <div className="mt-6 rounded-2xl border border-red-400/20 bg-red-500/15 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {avatars.map((avatar, index) => {
              const isPrimary = index === 0
              const isBusy = busyAvatar === avatar.ownerId
              return (
                <div
                  key={`${avatar.ownerId}-${avatar.avatarName}`}
                  className="rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(6,14,24,0.95),rgba(6,10,18,0.98))] p-4"
                >
                  <img
                    src={resolveAvatarUrl(avatar.avatarName)}
                    alt={avatar.avatarName}
                    className="h-20 w-20 rounded-full object-cover ring-2 ring-white/10"
                  />
                  <h2 className="mt-4 text-lg font-semibold text-white">{avatar.avatarName}</h2>
                  <p className="mt-1 text-xs text-white/55">
                    {isPrimary ? 'Empfohlener Start für dein Kennenlernen' : 'Bereit für deinen Chat'}
                  </p>

                  {isPrimary ? (
                    <button
                      type="button"
                      disabled={Boolean(busyAvatar)}
                      onClick={() => void handleStartOnboardingCall(avatar)}
                      className="mt-5 w-full rounded-2xl bg-[#00a884] px-4 py-3 text-sm font-semibold text-[#08111a] transition hover:brightness-110 disabled:opacity-60"
                    >
                      {isBusy ? 'Starte Kennenlernen…' : 'Kennenlernen starten'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={Boolean(busyAvatar)}
                      onClick={() => void handleStartChat(avatar)}
                      className="mt-5 w-full rounded-2xl border border-white/12 bg-white/5 px-4 py-3 text-sm font-semibold text-white/90 transition hover:bg-white/10 disabled:opacity-60"
                    >
                      {isBusy ? 'Öffne Chat…' : 'Chat starten'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          <div className="mt-8 text-center">
            <button
              type="button"
              onClick={() => navigate('/avatars')}
              className="text-sm text-white/60 transition hover:text-white"
            >
              Alle verfügbaren Avatare anzeigen
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
