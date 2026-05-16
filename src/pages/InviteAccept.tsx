import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  getOnboardingInvitation,
  type InvitationRecord,
} from '../lib/api'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { getCanonicalAppUrl } from '../lib/canonicalOrigin'

const PENDING_KEY = 'wa_pending_onboarding_invite'
const SIGNUP_DONE_KEY_PREFIX = 'wa_onboarding_signup_done:'

type Locale = 'en' | 'es' | 'de'

const COPY: Record<Locale, {
  welcome: (name: string) => string
  unlock: (avatars: string) => string
  nameLabel: string
  namePlaceholder: string
  emailLabel: string
  passwordLabel: string
  passwordPlaceholder: string
  confirmPasswordLabel: string
  confirmPasswordPlaceholder: string
  createAccount: string
  creating: string
  passwordsMismatch: string
  passwordTooShort: string
  emailRequired: string
  alreadyRegistered: string
  inviteUnavailable: string
  inviteCannotBeUsed: string
  verificationTitle: string
  verificationBody: string
  invalidLink: string
  alreadyUsed: string
  expired: string
  nameRequired: string
}> = {
  en: {
    welcome: (name) => `Hey ${name || 'there'}, welcome to WhatsAnima`,
    unlock: (avatars) => `Create your account to unlock: ${avatars}.`,
    nameLabel: 'How should I call you?',
    namePlaceholder: 'First name or nickname',
    emailLabel: 'Email',
    passwordLabel: 'Password',
    passwordPlaceholder: 'At least 8 characters',
    confirmPasswordLabel: 'Confirm password',
    confirmPasswordPlaceholder: 'Repeat your password',
    createAccount: 'Create Account',
    creating: 'Creating account…',
    passwordsMismatch: 'Passwords do not match.',
    passwordTooShort: 'Password must be at least 8 characters.',
    emailRequired: 'Please provide email and password.',
    nameRequired: 'Please tell us how to call you.',
    alreadyRegistered: 'This email is already registered. Please log in or use a different email.',
    inviteUnavailable: 'Invitation not available',
    inviteCannotBeUsed: 'This invitation cannot be used right now.',
    verificationTitle: 'Email confirmation required',
    verificationBody: 'Check your email and click the confirmation link to continue.',
    invalidLink: 'This invitation link is invalid.',
    alreadyUsed: 'This invitation link has already been used.',
    expired: 'This invitation link has expired. Please request a new one.',
  },
  es: {
    welcome: (name) => `Hola ${name || 'amigo'}, bienvenido a WhatsAnima`,
    unlock: (avatars) => `Crea tu cuenta para desbloquear: ${avatars}.`,
    nameLabel: '¿Cómo te llamo?',
    namePlaceholder: 'Nombre o apodo',
    emailLabel: 'Correo electrónico',
    passwordLabel: 'Contraseña',
    passwordPlaceholder: 'Al menos 8 caracteres',
    confirmPasswordLabel: 'Confirmar contraseña',
    confirmPasswordPlaceholder: 'Repite tu contraseña',
    createAccount: 'Crear cuenta',
    creating: 'Creando cuenta…',
    passwordsMismatch: 'Las contraseñas no coinciden.',
    passwordTooShort: 'La contraseña debe tener al menos 8 caracteres.',
    emailRequired: 'Por favor ingresa email y contraseña.',
    nameRequired: 'Por favor dinos cómo llamarte.',
    alreadyRegistered: 'Este correo ya está registrado. Inicia sesión o usa otro correo.',
    inviteUnavailable: 'Invitación no disponible',
    inviteCannotBeUsed: 'Esta invitación no se puede usar en este momento.',
    verificationTitle: 'Confirmación de email requerida',
    verificationBody: 'Revisa tu correo y haz clic en el enlace de confirmación para continuar.',
    invalidLink: 'Este enlace de invitación no es válido.',
    alreadyUsed: 'Este enlace de invitación ya fue utilizado.',
    expired: 'Este enlace de invitación ha expirado. Solicita uno nuevo.',
  },
  de: {
    welcome: (name) => `Hey ${name || 'du'}, willkommen bei WhatsAnima`,
    unlock: (avatars) => `Erstelle dein Konto, um freizuschalten: ${avatars}.`,
    nameLabel: 'Wie darf ich dich nennen?',
    namePlaceholder: 'Vorname oder Spitzname',
    emailLabel: 'E-Mail',
    passwordLabel: 'Passwort',
    passwordPlaceholder: 'Mindestens 8 Zeichen',
    confirmPasswordLabel: 'Passwort bestätigen',
    confirmPasswordPlaceholder: 'Passwort wiederholen',
    createAccount: 'Konto erstellen',
    creating: 'Konto wird erstellt…',
    passwordsMismatch: 'Passwörter stimmen nicht überein.',
    passwordTooShort: 'Passwort muss mindestens 8 Zeichen haben.',
    emailRequired: 'Bitte E-Mail und Passwort eingeben.',
    nameRequired: 'Bitte sag uns, wie wir dich nennen sollen.',
    alreadyRegistered: 'Diese E-Mail ist bereits registriert. Bitte logge dich ein oder nutze eine andere E-Mail.',
    inviteUnavailable: 'Einladung nicht verfügbar',
    inviteCannotBeUsed: 'Diese Einladung kann gerade nicht verwendet werden.',
    verificationTitle: 'E-Mail-Bestätigung erforderlich',
    verificationBody: 'Prüfe deine E-Mail und klicke auf den Bestätigungslink.',
    invalidLink: 'Dieser Einladungslink ist ungültig.',
    alreadyUsed: 'Dieser Einladungslink wurde bereits verwendet.',
    expired: 'Dieser Einladungslink ist abgelaufen. Bitte fordere einen neuen an.',
  },
}

function pickLocale(value: string | null | undefined): Locale {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized.startsWith('es')) return 'es'
  if (normalized.startsWith('de')) return 'de'
  return 'en'
}

function isExpired(invitation: InvitationRecord | null): boolean {
  if (!invitation?.expires_at) return false
  return new Date(invitation.expires_at).getTime() <= Date.now()
}

export default function InviteAccept() {
  const { inviteCode = '' } = useParams<{ inviteCode: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [invitation, setInvitation] = useState<InvitationRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [showVerificationScreen, setShowVerificationScreen] = useState(false)


  const locale = useMemo<Locale>(() => pickLocale(invitation?.language), [invitation?.language])
  const copy = COPY[locale]

  const primaryAvatarName = useMemo(
    () => (invitation?.allowed_avatars?.[0] || '').trim(),
    [invitation?.allowed_avatars],
  )

  useEffect(() => {
    if (!inviteCode) {
      setError('Invitation code missing.')
      setLoading(false)
      return
    }

    void (async () => {
      const data = await getOnboardingInvitation(inviteCode)
      setInvitation(data)
      const local = data ? COPY[pickLocale(data.language)] : COPY.en
      if (!data) {
        setError(local.invalidLink)
      } else if (data.status !== 'pending') {
        setError(data.status === 'accepted' ? local.alreadyUsed : local.inviteCannotBeUsed)
      } else if (isExpired(data)) {
        setError(local.expired)
      } else {
        setEmail(data.invitee_email || '')
        setName((data.invitee_name || '').trim())
      }
      setLoading(false)
    })()
  }, [inviteCode])

  useEffect(() => {
    if (!inviteCode) return
    try {
      const persisted = sessionStorage.getItem(`${SIGNUP_DONE_KEY_PREFIX}${inviteCode}`)
      if (persisted === '1') setShowVerificationScreen(true)
    } catch {
      // ignore storage errors
    }
  }, [inviteCode])

  useEffect(() => {
    if (user?.email_confirmed_at) {
      navigate('/onboarding', { replace: true })
    }
  }, [navigate, user?.email_confirmed_at])

  async function handleSignup(event: FormEvent) {
    event.preventDefault()
    if (!email.trim() || !password.trim()) {
      setError(copy.emailRequired)
      return
    }
    if (!name.trim()) {
      setError(copy.nameRequired)
      return
    }
    if (password.length < 8) {
      setError(copy.passwordTooShort)
      return
    }
    if (password !== confirmPassword) {
      setError(copy.passwordsMismatch)
      return
    }

    setError(null)
    setSubmitting(true)
    localStorage.setItem(PENDING_KEY, JSON.stringify({ inviteCode }))

    const trimmedName = name.trim()

    const { error: signUpError } = await supabase.auth.signUp({
      email: email.trim(),
      password: password.trim(),
      options: {
        emailRedirectTo: getCanonicalAppUrl(`/auth/callback?next=${encodeURIComponent('/onboarding')}`),
        data: {
          invite_code: inviteCode,
          invitee_name: trimmedName,
          first_name: trimmedName,
          language: invitation?.language || 'en',
        },
      },
    })

    if (signUpError) {
      const normalized = String(signUpError.message || '').toLowerCase()
      if (normalized.includes('already registered') || normalized.includes('already been registered') || normalized.includes('user already')) {
        setError(copy.alreadyRegistered)
      } else {
        setError(signUpError.message)
      }
      setSubmitting(false)
      return
    }

    // Invitation acceptance moved to Onboarding.tsx (after email verification)

    setSubmitting(false)
    setShowVerificationScreen(true)
    setPassword('')
    setConfirmPassword('')
    try {
      sessionStorage.setItem(`${SIGNUP_DONE_KEY_PREFIX}${inviteCode}`, '1')
    } catch {
      // ignore storage errors
    }
  }

  if (loading) {
    return (
      <div className="brand-scene flex min-h-screen items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-[#1f2c34] border-t-[#00a884]" />
      </div>
    )
  }

  if (error || !invitation) {
    return (
      <div className="brand-scene min-h-screen text-white">
        <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-xl items-center justify-center px-6 py-10">
          <div className="brand-panel w-full rounded-[30px] p-8 text-center">
            <h1 className="text-2xl font-bold">{copy.inviteUnavailable}</h1>
            <p className="mt-3 text-sm text-white/70">{error || copy.inviteCannotBeUsed}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="brand-scene min-h-screen text-white">
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-xl items-center justify-center px-6 py-10">
        <div className="brand-panel w-full rounded-[30px] p-8 sm:p-10">
          {!showVerificationScreen ? (
            <>
              <h1 className="text-3xl font-bold tracking-tight">
                {copy.welcome(invitation.invitee_name || '')}
              </h1>
              <p className="mt-3 text-sm text-white/70">
                {copy.unlock(invitation.allowed_avatars.join(', '))}
              </p>

              <form onSubmit={handleSignup} className="mt-8 space-y-4">
                <div>
                  <label className="mb-2 block text-sm text-white/80">{copy.nameLabel}</label>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    type="text"
                    className="brand-inset w-full rounded-2xl px-4 py-3 text-white outline-none focus:border-[#00a884]"
                    placeholder={copy.namePlaceholder}
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm text-white/80">{copy.emailLabel}</label>
                  <input
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                    type="email"
                    className="brand-inset w-full rounded-2xl px-4 py-3 text-white outline-none focus:border-[#00a884]"
                    placeholder="you@example.com"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm text-white/80">{copy.passwordLabel}</label>
                  <input
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    type="password"
                    className="brand-inset w-full rounded-2xl px-4 py-3 text-white outline-none focus:border-[#00a884]"
                    placeholder={copy.passwordPlaceholder}
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm text-white/80">{copy.confirmPasswordLabel}</label>
                  <input
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    required
                    type="password"
                    className="brand-inset w-full rounded-2xl px-4 py-3 text-white outline-none focus:border-[#00a884]"
                    placeholder={copy.confirmPasswordPlaceholder}
                  />
                </div>

                {error ? (
                  <p className="rounded-2xl border border-red-400/20 bg-red-500/15 px-4 py-3 text-sm text-red-200">{error}</p>
                ) : null}

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full rounded-2xl bg-[#00a884] px-4 py-3 font-semibold text-[#08111a] transition hover:brightness-110 disabled:opacity-60"
                >
                  {submitting ? copy.creating : copy.createAccount}
                </button>
              </form>
            </>
          ) : (
            <>
              <h1 className="text-3xl font-bold tracking-tight">{copy.verificationTitle}</h1>
              <p className="mt-3 text-sm text-white/70">{copy.verificationBody}</p>
              {primaryAvatarName ? (
                <p className="mt-6 text-center text-xs text-white/50">{primaryAvatarName}</p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
