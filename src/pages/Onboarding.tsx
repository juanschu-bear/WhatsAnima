import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import {
  acceptOnboardingInvitation,
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
  provider: 'keyframe' | 'tavus'
  onboardingCompleted: boolean
}

type Locale = 'en' | 'es' | 'de'

const COPY: Record<Locale, {
  welcome: (name: string) => string
  intro: string
  quote: string
  startOnboarding: string
  startingOnboarding: string
  startChat: string
  openingChat: string
  noAvatars: string
  loadFailed: string
  chatFailed: string
  callFailed: string
  elite: string
  premium: string
  contactMissing: string
}> = {
  en: {
    welcome: (name) => `Welcome ${name}, your avatars are ready!`,
    intro: 'Think of it like a first date with your avatars. Tell them who you are, and they will tell you what they bring to the table. After that you know each other, and we can get going.',
    quote: '',
    startOnboarding: 'Start getting to know',
    startingOnboarding: 'Starting…',
    startChat: 'Start chat',
    openingChat: 'Opening chat…',
    noAvatars: 'No avatars are unlocked for your account yet.',
    loadFailed: 'Onboarding could not be loaded.',
    chatFailed: 'Chat could not be started.',
    callFailed: 'Onboarding call could not be started.',
    elite: 'Elite Avatar',
    premium: 'Premium Avatar',
    contactMissing: 'Contact could not be determined.',
  },
  es: {
    welcome: (name) => `Bienvenido ${name}, tus avatares estan listos!`,
    intro: 'Imaginalo como una primera cita con tus avatares. Cuentales quien eres, y ellos te contaran que saben hacer. Despues ya se conocen y podemos empezar.',
    quote: '"Hablen como hablarian con un amigo inteligente. Sin filtros. Sin formalidades. Como si estuvieran en su sala tomando cafe. Porque las mejores conversaciones pasan cuando te olvidas de quien se supone que eres y simplemente eres tu." Prof. Ryan Cox',
    startOnboarding: 'Empezar a conocer',
    startingOnboarding: 'Iniciando…',
    startChat: 'Iniciar chat',
    openingChat: 'Abriendo chat…',
    noAvatars: 'Aun no se han desbloqueado avatares para tu cuenta.',
    loadFailed: 'No se pudo cargar el onboarding.',
    chatFailed: 'No se pudo iniciar el chat.',
    callFailed: 'No se pudo iniciar la llamada de onboarding.',
    elite: 'Avatar Elite',
    premium: 'Avatar Premium',
    contactMissing: 'No se pudo determinar el contacto.',
  },
  de: {
    welcome: (name) => `Willkommen ${name}, deine Avatare sind bereit!`,
    intro: 'Stell es dir vor wie ein erstes Date mit deinen Avataren. Erzaehl ihnen wer du bist, und sie erzaehlen dir was sie drauf haben. Danach kennt ihr euch, und es kann losgehen.',
    quote: '',
    startOnboarding: 'Kennenlernen starten',
    startingOnboarding: 'Starte Kennenlernen…',
    startChat: 'Chat starten',
    openingChat: 'Oeffne Chat…',
    noAvatars: 'Fuer dein Konto wurden noch keine Avatare freigeschaltet.',
    loadFailed: 'Onboarding konnte nicht geladen werden.',
    chatFailed: 'Chat konnte nicht gestartet werden.',
    callFailed: 'Onboarding Call konnte nicht gestartet werden.',
    elite: 'Elite Avatar',
    premium: 'Premium Avatar',
    contactMissing: 'Kontakt konnte nicht bestimmt werden.',
  },
}

const DISPLAY_NAME_MAP: Record<string, string> = {
  'Prof. Brian Cox': 'Prof. Ryan Cox',
}

function displayName(name: string): string {
  return DISPLAY_NAME_MAP[name] || name
}

const AVATAR_DESCRIPTIONS: Record<Locale, Record<string, string>> = {
  en: {
    'Trace Flores': 'Business strategy, behavioral patterns, and memory. Helps you prioritize, recognize patterns, and find your next move.',
    'Prof. Brian Cox': 'Science and physics made accessible. Explains complex topics clearly for curious minds of any age.',
    'Elena Navarro': 'Sales strategy, presentation skills, and structured communication. Helps you sell better and get your point across.',
  },
  es: {
    'Trace Flores': 'Estratega de negocios, patrones de comportamiento y memoria. Te ayuda a priorizar, reconocer patrones y encontrar tu proximo paso.',
    'Prof. Brian Cox': 'Experto en ciencia y fisica accesible. Explica temas complejos de forma clara para mentes curiosas de cualquier edad.',
    'Elena Navarro': 'Estratega de ventas, presentacion y comunicacion estructurada. Eleva tus ventas y te apoya a ir al punto y ejecutar.',
  },
  de: {
    'Trace Flores': 'Business-Strategie, Verhaltensmuster und Erinnerung. Hilft dir Prioritaeten zu setzen, Muster zu erkennen und den naechsten Schritt zu finden.',
    'Prof. Brian Cox': 'Wissenschaft und Physik verstaendlich erklaert. Komplexe Themen klar aufbereitet fuer neugierige Koepfe jeden Alters.',
    'Elena Navarro': 'Verkaufsstrategie, Praesentationsskills und strukturierte Kommunikation. Hilft dir besser zu verkaufen und auf den Punkt zu kommen.',
  },
}

function pickLocale(value: string | null | undefined): Locale {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized.startsWith('es')) return 'es'
  if (normalized.startsWith('de')) return 'de'
  return 'en'
}

function isKeyframeDisplayName(value: string) {
  const normalized = value.trim().toLowerCase()
  return normalized.includes('trace flores') || normalized.includes('jordan cash')
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
  const locale = pickLocale(inviteLanguage)
  const copy = COPY[locale]

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
        // Accept invitation if not yet accepted (idempotent on backend)
        try {
          await acceptOnboardingInvitation({
            inviteCode,
            userId: user.id,
            userEmail: user.email || null,
            inviteeName: welcomeName || null,
          })
        } catch {
          // Already accepted or other non-fatal error, continue loading
        }

        const { data: accessRows, error: accessError } = await supabase
          .from('wa_user_avatar_access')
          .select('owner_id, avatar_name')
          .eq('user_id', user.id)
          .is('revoked_at', null)

        if (accessError) throw accessError

        const ownerIds = Array.from(
          new Set((accessRows ?? []).map((row) => String(row.owner_id || '').trim()).filter(Boolean)),
        )

        let ownerRows: Array<{ id: string; display_name: string | null; settings?: unknown; tavus_replica_id?: string | null }> = []
        if (ownerIds.length > 0) {
          const { data: owners, error: ownerError } = await supabase
            .from('wa_owners')
            .select('id, display_name, settings, tavus_replica_id')
            .in('id', ownerIds)
            .is('deleted_at', null)

          if (ownerError) throw ownerError
          ownerRows = (owners || []) as Array<{ id: string; display_name: string | null; settings?: unknown; tavus_replica_id?: string | null }>
        }

        const ownerNameById = new Map<string, string>()
        const ownerProviderById = new Map<string, 'keyframe' | 'tavus'>()
        for (const owner of ownerRows) {
          const ownerId = String(owner.id || '').trim()
          const ownerName = String(owner.display_name || '').trim()
          if (ownerId && ownerName) ownerNameById.set(ownerId, ownerName)
          const settings = owner.settings && typeof owner.settings === 'object' ? owner.settings as Record<string, unknown> : null
          const personaSlug = typeof settings?.persona_slug === 'string' ? settings.persona_slug.trim() : ''
          const provider: 'keyframe' | 'tavus' = isKeyframeDisplayName(ownerName.toLowerCase())
            ? 'keyframe'
            : (personaSlug ? 'keyframe' : 'tavus')
          if (ownerId) ownerProviderById.set(ownerId, provider)
        }

        const { data: onboardingRows, error: onboardingError } = await supabase
          .from('wa_user_onboarding')
          .select('avatar_name, onboarding_completed')
          .eq('user_id', user.id)

        if (onboardingError) throw onboardingError
        const onboardingByAvatar = new Map<string, boolean>()
        for (const row of onboardingRows ?? []) {
          const avatarName = String(row.avatar_name || '').trim()
          if (avatarName) onboardingByAvatar.set(avatarName, Boolean(row.onboarding_completed))
        }

        const normalized: OnboardingAvatar[] = []
        const seen = new Set<string>()
        for (const row of accessRows || []) {
          const ownerId = String(row.owner_id || '').trim()
          const fallbackName = String(row.avatar_name || '').trim()
          const avatarName = ownerNameById.get(ownerId) || fallbackName
          if (!ownerId || !avatarName) continue
          const provider = ownerProviderById.get(ownerId) || (isKeyframeDisplayName(avatarName) ? 'keyframe' : 'tavus')
          const key = `${ownerId}::${avatarName}`
          if (seen.has(key)) continue
          seen.add(key)
          normalized.push({
            ownerId,
            avatarName,
            provider,
            onboardingCompleted: onboardingByAvatar.get(avatarName) ?? false,
          })
        }

        if (cancelled) return

        if (normalized.length === 0) {
          setAvatars([])
          setError(copy.noAvatars)
          return
        }

        const allCompleted = normalized.every((entry) => entry.onboardingCompleted)
        if (allCompleted) {
          const first = normalized[0]
          try {
            const existingContact = await findContactByEmailForOwner(first.ownerId, user.email || '')
            const contactId = existingContact?.id
              ? existingContact.id
              : (await createContactForOwner({
                  ownerId: first.ownerId,
                  firstName: welcomeName,
                  lastName: '',
                  email: user.email || '',
                })).id
            const conversationId = await findOrCreateConversation(first.ownerId, contactId)
            navigate(`/chat/${conversationId}`, { replace: true })
            return
          } catch {
            // fall through and render the onboarding screen
          }
        }

        setAvatars(normalized)
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : copy.loadFailed)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [inviteCode, navigate, user, copy.loadFailed, copy.noAvatars, welcomeName])

  async function ensureConversation(ownerId: string) {
    if (!user?.email) throw new Error('User email missing')

    const existingContact = await findContactByEmailForOwner(ownerId, user.email)
    if (existingContact?.id) {
      return findOrCreateConversation(ownerId, existingContact.id)
    }

    const firstName = String(user.user_metadata?.first_name || '').trim() || welcomeName
    const lastName = String(user.user_metadata?.last_name || '').trim() || ''
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
      setError(chatError instanceof Error ? chatError.message : copy.chatFailed)
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
      if (!contactId) throw new Error(copy.contactMissing)

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

      // User stays on onboarding page. IncomingCallOverlay will show the
      // ringing UI and navigate directly into the call when they answer.
      // Set flag so VideoCall navigates back to /onboarding after call ends.
      try {
        sessionStorage.setItem(
          `wa_onboarding_call:${conversationId}`,
          JSON.stringify({ avatarName: avatar.avatarName, ownerId: avatar.ownerId }),
        )
      } catch {
        // ignore storage errors
      }
      setBusyAvatar(null)
    } catch (callError) {
      setError(callError instanceof Error ? callError.message : copy.callFailed)
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
          <h1 className="text-3xl font-bold tracking-tight">{copy.welcome(welcomeName)}</h1>
          <p className="mt-3 text-sm text-white/70">{copy.intro}</p>
          {copy.quote && (
            <p className="mt-4 text-sm italic text-white/50">{copy.quote}</p>
          )}

          <div className="mt-6 flex items-center gap-3 rounded-2xl bg-white/5 px-4 py-3">
            <div className="flex items-center gap-2">
              <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${avatars.some(a => !a.onboardingCompleted) ? 'bg-[#00a884] text-[#08111a]' : 'bg-white/10 text-white/40'}`}>1</div>
              <span className={`text-xs font-medium ${avatars.some(a => !a.onboardingCompleted) ? 'text-white' : 'text-white/40'}`}>Conoce a tus avatares</span>
            </div>
            <div className="h-px flex-1 bg-white/10" />
            <div className="flex items-center gap-2">
              <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${avatars.every(a => a.onboardingCompleted) ? 'bg-[#00a884] text-[#08111a]' : 'bg-white/10 text-white/40'}`}>2</div>
              <span className={`text-xs font-medium ${avatars.every(a => a.onboardingCompleted) ? 'text-white' : 'text-white/40'}`}>Empieza a chatear</span>
            </div>
          </div>

          {error ? (
            <div className="mt-6 rounded-2xl border border-red-400/20 bg-red-500/15 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {avatars.map((avatar) => {
              const isBusy = busyAvatar === avatar.ownerId
              const completed = avatar.onboardingCompleted
              return (
                <div
                  key={`${avatar.ownerId}-${avatar.avatarName}`}
                  className={`rounded-[24px] border p-4 ${completed ? 'border-white/10 bg-[linear-gradient(180deg,rgba(6,14,24,0.95),rgba(6,10,18,0.98))]' : 'border-[#00a884]/30 bg-[linear-gradient(180deg,rgba(6,14,24,0.95),rgba(6,10,18,0.98))] shadow-[0_0_20px_rgba(0,168,132,0.15)]'}`}
                >
                  <img
                    src={resolveAvatarUrl(avatar.avatarName)}
                    alt={avatar.avatarName}
                    className="h-20 w-20 rounded-full object-cover ring-2 ring-white/10"
                  />
                  <h2 className="mt-4 text-lg font-semibold text-white">{displayName(avatar.avatarName)}</h2>
                  {AVATAR_DESCRIPTIONS[locale]?.[avatar.avatarName] && (
                    <p className="mt-1.5 text-xs leading-relaxed text-white/55">
                      {AVATAR_DESCRIPTIONS[locale][avatar.avatarName]}
                    </p>
                  )}
                  <p className="mt-2 inline-flex rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/70">
                    {avatar.provider === 'keyframe' ? copy.elite : copy.premium}
                  </p>

                  {completed ? (
                    <button
                      type="button"
                      disabled={Boolean(busyAvatar)}
                      onClick={() => void handleStartChat(avatar)}
                      className="mt-5 w-full rounded-2xl border border-white/12 bg-white/5 px-4 py-3 text-sm font-semibold text-white/90 transition hover:bg-white/10 disabled:opacity-60"
                    >
                      {isBusy ? copy.openingChat : copy.startChat}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={Boolean(busyAvatar)}
                      onClick={() => void handleStartOnboardingCall(avatar)}
                      className="mt-5 w-full rounded-2xl bg-[#00a884] px-4 py-3 text-sm font-semibold text-[#08111a] transition hover:brightness-110 disabled:opacity-60"
                    >
                      {isBusy ? copy.startingOnboarding : copy.startOnboarding}
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          <div className="mt-6 rounded-2xl border border-[#00a884]/20 bg-[#00a884]/5 px-5 py-4">
            <p className="text-sm leading-relaxed text-[#00a884]/90">
              <span className="font-semibold">Tip:</span> Haz una videollamada con cada avatar para conocerlos. Despues podras chatear con ellos cuando quieras. Si ya estas en el chat, pulsa los tres puntos arriba a la derecha y selecciona "Home" para volver aqui. Para las siguientes llamadas, recomendamos seleccionar el modo "Side by side" en la pantalla inicial.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-[#00a884]/90">
              <span className="font-semibold">Ojo:</span> El avatar siempre hablara en el idioma que selecciones en la pantalla inicial del call. Solo en la primera llamada de presentacion se adapta automaticamente. En las demas, asegurate de elegir el idioma correcto antes de iniciar.
            </p>
          </div>

          <div className="mt-4 rounded-2xl border border-amber-400/20 bg-amber-500/5 px-5 py-4">
            <p className="text-sm leading-relaxed text-amber-200/90">
              <span className="font-semibold">Tu tiempo:</span> Tienes 3 avatares x 30 minutos = <span className="font-semibold text-white">90 minutos de videollamadas</span> para explorar la experiencia. Cada avatar tiene su propio contador de 30 minutos. Los mensajes de texto, voz y video en el chat son ilimitados. Solo las videollamadas en vivo tienen limite.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-red-300/90">
              <span className="font-semibold">Importante:</span> Siempre termina tus videollamadas con el boton rojo "Leave". No cierres la ventana ni el navegador sin pulsar "Leave" primero, porque los minutos seguiran contando.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
