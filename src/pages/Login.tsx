import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { listAllOwners, createContactForOwner, findOrCreateConversation } from '../lib/api'
import { type Locale, getStoredLocale, setStoredLocale, t } from '../lib/i18n'
import { resolveAvatarUrl } from '../lib/avatars'

type Step = 'language' | 'role' | 'owner-email' | 'user-choice' | 'user-email' | 'new-user' | 'new-user-details'

interface OwnerOption {
  id: string
  display_name: string
}

export default function Login() {
  const navigate = useNavigate()
  const [locale, setLocale] = useState<Locale>(getStoredLocale)
  const [step, setStep] = useState<Step>('language')
  const [role, setRole] = useState<'owner' | 'user' | null>(null)

  // Email form state
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authMode, setAuthMode] = useState<'password' | 'magic-link'>('password')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [emailSent, setEmailSent] = useState(false)

  // New user flow
  const [inviteLink, setInviteLink] = useState('')
  const [owners, setOwners] = useState<OwnerOption[]>([])
  const [selectedOwner, setSelectedOwner] = useState<OwnerOption | null>(null)
  const [ownersLoading, setOwnersLoading] = useState(false)

  function pickLocale(l: Locale) {
    setLocale(l)
    setStoredLocale(l)
    setStep('role')
  }

  // Check if already logged in
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) navigate('/', { replace: true })
    })
  }, [navigate])

  // Listen for auth state changes
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') {
        if (role) localStorage.setItem('wa_login_role', role)
        navigate(role === 'owner' ? '/' : '/avatars', { replace: true })
      }
    })
    return () => subscription.unsubscribe()
  }, [navigate, role])

  // Load owners when entering new-user step
  useEffect(() => {
    if (step !== 'new-user') return
    setOwnersLoading(true)
    listAllOwners()
      .then((data) => setOwners(data as OwnerOption[]))
      .catch(() => {})
      .finally(() => setOwnersLoading(false))
  }, [step])

  // Handle invite link paste
  function handleInviteLinkSubmit() {
    const trimmed = inviteLink.trim()
    // Extract token from URL like /invite/TOKEN or just use raw token
    const match = trimmed.match(/\/invite\/([a-f0-9-]+)/i) || trimmed.match(/^([a-f0-9-]{36})$/i)
    if (!match) {
      setError(t(locale, 'invalidInviteLink'))
      return
    }
    // Navigate to invite page with extracted token
    window.location.href = `/invite/${match[1]}`
  }

  // Select an owner → show details form
  function handleSelectOwner(owner: OwnerOption) {
    setSelectedOwner(owner)
    setError(null)
    setStep('new-user-details')
  }

  // Send magic link or sign in with password
  async function handleSendLink(event: FormEvent) {
    event.preventDefault()
    if (!email.trim()) {
      setError('Enter your email address.')
      return
    }
    setError(null)
    setLoading(true)

    // Password-based sign in
    if (authMode === 'password') {
      if (!password) {
        setError(t(locale, 'passwordPlaceholder'))
        setLoading(false)
        return
      }
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      })
      if (signInError) {
        setError(t(locale, 'invalidCredentials'))
        setLoading(false)
        return
      }
      // onAuthStateChange will handle navigation
      setLoading(false)
      return
    }

    // Persist role before magic-link redirect
    if (role) localStorage.setItem('wa_login_role', role)

    // Magic link flow — redirect through /auth/callback with PKCE
    const nextPath = role === 'owner' ? '/' : '/avatars'
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}`

    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        shouldCreateUser: role === 'user',
        emailRedirectTo: redirectTo,
      },
    })

    if (otpError) {
      if (role === 'owner' && otpError.message.toLowerCase().includes('not allowed')) {
        setError(t(locale, 'noOwnerFound'))
      } else {
        setError(otpError.message)
      }
      setLoading(false)
      return
    }

    setEmailSent(true)
    setLoading(false)
  }

  // New user: create contact + sign up with password or magic link
  async function handleNewUserSubmit(event: FormEvent) {
    event.preventDefault()
    if (!firstName.trim() || !lastName.trim() || !email.trim()) {
      setError('Please fill in all fields.')
      return
    }
    if (!selectedOwner) return

    // Password validation for new users
    if (authMode === 'password') {
      if (!password) {
        setError(t(locale, 'passwordPlaceholder'))
        return
      }
      if (password.length < 6) {
        setError(t(locale, 'passwordTooShort'))
        return
      }
    }

    setError(null)
    setLoading(true)

    try {
      // Create contact for the selected owner
      const contact = await createContactForOwner({
        ownerId: selectedOwner.id,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
      })

      // Create conversation
      const conversationId = await findOrCreateConversation(selectedOwner.id, contact.id)

      if (authMode === 'password' && password) {
        // Sign up with password — no email redirect needed, stays in PWA
        const { error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: {
              first_name: firstName.trim(),
              last_name: lastName.trim(),
            },
          },
        })
        if (signUpError) {
          setError(signUpError.message)
          setLoading(false)
          return
        }
        // onAuthStateChange will handle navigation
        setLoading(false)
        return
      }

      // Magic link fallback — redirect through /auth/callback
      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(`/chat/${conversationId}`)}`
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          shouldCreateUser: true,
          emailRedirectTo: redirectTo,
          data: {
            first_name: firstName.trim(),
            last_name: lastName.trim(),
          },
        },
      })

      if (otpError) {
        setError(otpError.message)
        setLoading(false)
        return
      }

      setEmailSent(true)
      setLoading(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
      setLoading(false)
    }
  }

  function goBack() {
    setError(null)
    setEmailSent(false)
    if (step === 'role') { setStep('language'); return }
    if (step === 'owner-email') { setStep('role'); setRole(null); return }
    if (step === 'user-choice') { setStep('role'); setRole(null); return }
    if (step === 'user-email') { setStep('user-choice'); return }
    if (step === 'new-user') { setStep('user-choice'); return }
    if (step === 'new-user-details') { setStep('new-user'); setSelectedOwner(null); return }
    setStep('role')
  }

  // --- RENDER ---

  const panel = (children: React.ReactNode, showBack = true) => (
    <div className="brand-scene min-h-[100dvh]">
      <div className="relative z-10 flex min-h-[100dvh] items-center justify-center px-6 py-8">
        <div className="brand-panel w-full max-w-md rounded-[32px] p-7 sm:p-8">
          <img
            src="/Icon.PNG"
            alt="WhatsAnima"
            className="mx-auto mb-4 h-16 w-auto object-contain drop-shadow-[0_0_22px_rgba(93,236,214,0.34)]"
          />
          {children}
          {showBack && step !== 'language' && (
            <button
              type="button"
              onClick={goBack}
              className="mt-6 block w-full text-center text-sm text-white/50 transition hover:text-white/80"
            >
              {'\u2190'} {t(locale, 'backToOptions')}
            </button>
          )}
        </div>
      </div>
    </div>
  )

  // Email sent confirmation (reusable)
  const emailSentUI = (
    <div className="space-y-4">
      <div className="rounded-2xl border border-[#00a884]/20 bg-[#00a884]/10 px-5 py-4 text-sm leading-relaxed text-[#00a884]">
        {t(locale, 'verificationSent')} <strong>{email}</strong>.
        <br />
        {t(locale, 'openEmailToContinue')}
      </div>
      <button
        type="button"
        onClick={() => { setEmailSent(false); setLoading(false) }}
        className="text-sm text-white/50 underline transition hover:text-white/80"
      >
        {t(locale, 'useDifferentEmail')}
      </button>
    </div>
  )

  // ---- Step: Language picker ----
  if (step === 'language') {
    return panel(
      <>
        <h1 className="mb-2 text-center text-4xl font-bold tracking-tight text-white">WhatsAnima</h1>
        <p className="mb-8 text-center text-sm text-white/60">{t(locale, 'chooseLanguage')}</p>
        <div className="space-y-3">
          {([
            { code: 'en' as Locale, flag: '\u{1F1EC}\u{1F1E7}', label: 'English' },
            { code: 'de' as Locale, flag: '\u{1F1E9}\u{1F1EA}', label: 'Deutsch' },
            { code: 'es' as Locale, flag: '\u{1F1EA}\u{1F1F8}', label: 'Espa\u00f1ol' },
          ]).map((lang) => (
            <button
              key={lang.code}
              type="button"
              onClick={() => pickLocale(lang.code)}
              className="group w-full rounded-[20px] border border-white/8 bg-white/[0.03] p-5 text-left transition hover:border-[#00a884]/40 hover:bg-[#00a884]/[0.06]"
            >
              <div className="flex items-center gap-4">
                <span className="text-3xl">{lang.flag}</span>
                <p className="text-base font-semibold text-white">{lang.label}</p>
              </div>
            </button>
          ))}
        </div>
      </>,
      false,
    )
  }

  // ---- Step: Role selection ----
  if (step === 'role') {
    return panel(
      <>
        <h1 className="mb-2 text-center text-4xl font-bold tracking-tight text-white">{t(locale, 'welcome')}</h1>
        <p className="mb-8 text-center text-sm text-white/60">{t(locale, 'howSignIn')}</p>
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => { setRole('owner'); setStep('owner-email') }}
            className="group w-full rounded-[20px] border border-white/8 bg-white/[0.03] p-5 text-left transition hover:border-[#00a884]/40 hover:bg-[#00a884]/[0.06]"
          >
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#00a884]/15 text-lg text-[#00a884]">
                {'\u{1F4BC}'}
              </div>
              <div>
                <p className="text-base font-semibold text-white">{t(locale, 'avatarOwner')}</p>
                <p className="mt-0.5 text-sm text-white/50">{t(locale, 'avatarOwnerDesc')}</p>
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => { setRole('user'); setStep('user-choice') }}
            className="group w-full rounded-[20px] border border-white/8 bg-white/[0.03] p-5 text-left transition hover:border-[#53d0ff]/40 hover:bg-[#53d0ff]/[0.06]"
          >
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#53d0ff]/15 text-lg text-[#53d0ff]">
                {'\u{1F464}'}
              </div>
              <div>
                <p className="text-base font-semibold text-white">{t(locale, 'avatarUser')}</p>
                <p className="mt-0.5 text-sm text-white/50">{t(locale, 'avatarUserDesc')}</p>
              </div>
            </div>
          </button>
        </div>

        <p className="mt-6 text-center text-sm text-white/40">
          {t(locale, 'haveInviteLink')}
        </p>
      </>,
    )
  }

  // ---- Step: Owner email ----
  if (step === 'owner-email') {
    return panel(
      <>
        <h1 className="mb-2 text-center text-4xl font-bold tracking-tight text-white">{t(locale, 'avatarOwner')}</h1>
        <p className="mb-6 text-center text-sm text-white/65">{t(locale, 'avatarOwnerDesc')}</p>

        {emailSent ? emailSentUI : (
          <form onSubmit={handleSendLink} className="space-y-4">
            <div>
              <label htmlFor="login-email" className="mb-2 block text-sm font-medium text-white/82">
                {t(locale, 'email')}
              </label>
              <input
                id="login-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="brand-inset w-full rounded-2xl px-4 py-3.5 text-white placeholder-white/28 outline-none transition focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                placeholder="you@example.com"
              />
            </div>

            {authMode === 'password' && (
              <div>
                <label htmlFor="login-password" className="mb-2 block text-sm font-medium text-white/82">
                  {t(locale, 'password')}
                </label>
                <input
                  id="login-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="brand-inset w-full rounded-2xl px-4 py-3.5 text-white placeholder-white/28 outline-none transition focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                  placeholder={t(locale, 'passwordPlaceholder')}
                />
              </div>
            )}

            {error && (
              <p className="rounded-2xl border border-red-400/15 bg-red-500/15 px-4 py-3 text-sm text-red-200">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-2xl bg-[#00a884] py-3.5 text-lg font-semibold text-[#07141a] transition hover:brightness-110 disabled:opacity-50"
            >
              {loading
                ? (authMode === 'password' ? t(locale, 'signingIn') : t(locale, 'sending'))
                : (authMode === 'password' ? t(locale, 'signInWithPassword') : t(locale, 'sendVerificationEmail'))}
            </button>

            <button
              type="button"
              onClick={() => { setAuthMode(authMode === 'password' ? 'magic-link' : 'password'); setError(null) }}
              className="w-full text-center text-sm text-white/50 transition hover:text-white/80"
            >
              {authMode === 'password' ? t(locale, 'useMagicLink') : t(locale, 'usePassword')}
            </button>
          </form>
        )}

        <p className="mt-4 text-center text-base text-white/60">
          {t(locale, 'needAccount')}{' '}
          <Link to="/signup" className="font-medium text-[#00a884] hover:text-[#58e3c7]">
            {t(locale, 'signUp')}
          </Link>
        </p>
      </>,
    )
  }

  // ---- Step: User choice (existing / new) ----
  if (step === 'user-choice') {
    return panel(
      <>
        <h1 className="mb-2 text-center text-4xl font-bold tracking-tight text-white">{t(locale, 'avatarUser')}</h1>
        <p className="mb-8 text-center text-sm text-white/60">{t(locale, 'avatarUserDesc')}</p>

        <div className="space-y-3">
          <button
            type="button"
            onClick={() => setStep('user-email')}
            className="group w-full rounded-[20px] border border-white/8 bg-white/[0.03] p-5 text-left transition hover:border-[#00a884]/40 hover:bg-[#00a884]/[0.06]"
          >
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#00a884]/15 text-lg text-[#00a884]">
                {'\u{1F511}'}
              </div>
              <div>
                <p className="text-base font-semibold text-white">{t(locale, 'iHaveAccount')}</p>
                <p className="mt-0.5 text-sm text-white/50">{t(locale, 'iHaveAccountDesc')}</p>
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setStep('new-user')}
            className="group w-full rounded-[20px] border border-white/8 bg-white/[0.03] p-5 text-left transition hover:border-[#53d0ff]/40 hover:bg-[#53d0ff]/[0.06]"
          >
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#53d0ff]/15 text-lg text-[#53d0ff]">
                {'\u{2728}'}
              </div>
              <div>
                <p className="text-base font-semibold text-white">{t(locale, 'iAmNew')}</p>
                <p className="mt-0.5 text-sm text-white/50">{t(locale, 'iAmNewDesc')}</p>
              </div>
            </div>
          </button>
        </div>
      </>,
    )
  }

  // ---- Step: User email (existing account) ----
  if (step === 'user-email') {
    return panel(
      <>
        <h1 className="mb-2 text-center text-4xl font-bold tracking-tight text-white">{t(locale, 'iHaveAccount')}</h1>
        <p className="mb-6 text-center text-sm text-white/65">{t(locale, 'iHaveAccountDesc')}</p>

        {emailSent ? emailSentUI : (
          <form onSubmit={handleSendLink} className="space-y-4">
            <div>
              <label htmlFor="user-email" className="mb-2 block text-sm font-medium text-white/82">
                {t(locale, 'email')}
              </label>
              <input
                id="user-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="brand-inset w-full rounded-2xl px-4 py-3.5 text-white placeholder-white/28 outline-none transition focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                placeholder="you@example.com"
              />
            </div>

            {authMode === 'password' && (
              <div>
                <label htmlFor="user-password" className="mb-2 block text-sm font-medium text-white/82">
                  {t(locale, 'password')}
                </label>
                <input
                  id="user-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="brand-inset w-full rounded-2xl px-4 py-3.5 text-white placeholder-white/28 outline-none transition focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                  placeholder={t(locale, 'passwordPlaceholder')}
                />
              </div>
            )}

            {error && (
              <p className="rounded-2xl border border-red-400/15 bg-red-500/15 px-4 py-3 text-sm text-red-200">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-2xl bg-[#00a884] py-3.5 text-lg font-semibold text-[#07141a] transition hover:brightness-110 disabled:opacity-50"
            >
              {loading
                ? (authMode === 'password' ? t(locale, 'signingIn') : t(locale, 'sending'))
                : (authMode === 'password' ? t(locale, 'signInWithPassword') : t(locale, 'sendVerificationEmail'))}
            </button>

            <button
              type="button"
              onClick={() => { setAuthMode(authMode === 'password' ? 'magic-link' : 'password'); setError(null) }}
              className="w-full text-center text-sm text-white/50 transition hover:text-white/80"
            >
              {authMode === 'password' ? t(locale, 'useMagicLink') : t(locale, 'usePassword')}
            </button>
          </form>
        )}
      </>,
    )
  }

  // ---- Step: New user — invite link OR select owner ----
  if (step === 'new-user') {
    return panel(
      <>
        <h1 className="mb-2 text-center text-4xl font-bold tracking-tight text-white">{t(locale, 'iAmNew')}</h1>
        <p className="mb-6 text-center text-sm text-white/60">{t(locale, 'newUserInviteNote')}</p>

        {/* Invite link input */}
        <div className="space-y-3">
          <div>
            <label htmlFor="invite-link" className="mb-2 block text-sm font-medium text-white/82">
              {t(locale, 'pasteInviteLink')}
            </label>
            <div className="flex gap-2">
              <input
                id="invite-link"
                type="text"
                value={inviteLink}
                onChange={(e) => { setInviteLink(e.target.value); setError(null) }}
                className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/28 outline-none transition focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                placeholder="https://...../invite/..."
              />
              <button
                type="button"
                onClick={handleInviteLinkSubmit}
                disabled={!inviteLink.trim()}
                className="shrink-0 rounded-2xl bg-[#00a884] px-5 py-3 font-semibold text-[#07141a] transition hover:brightness-110 disabled:opacity-40"
              >
                {t(locale, 'continueBtn')}
              </button>
            </div>
          </div>

          {error && (
            <p className="rounded-2xl border border-red-400/15 bg-red-500/15 px-4 py-3 text-sm text-red-200">
              {error}
            </p>
          )}
        </div>

        {/* Divider */}
        <div className="my-6 flex items-center gap-3">
          <div className="h-px flex-1 bg-white/10" />
          <span className="text-xs text-white/40">{t(locale, 'orSelectOwner')}</span>
          <div className="h-px flex-1 bg-white/10" />
        </div>

        {/* Owner list */}
        {ownersLoading ? (
          <div className="flex justify-center py-6">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#1f2c34] border-t-[#00a884]" />
          </div>
        ) : (
          <div className="space-y-2">
            {owners.map((owner) => (
              <button
                key={owner.id}
                type="button"
                onClick={() => handleSelectOwner(owner)}
                className="w-full rounded-[20px] border border-white/6 bg-[rgba(8,22,30,0.7)] px-4 py-4 text-left transition hover:-translate-y-[1px] hover:border-[#00a884]/45 hover:bg-[rgba(10,27,37,0.8)]"
              >
                <div className="flex items-center gap-3">
                  <img
                    src={resolveAvatarUrl(owner.display_name)}
                    alt={owner.display_name}
                    className="h-10 w-10 rounded-full object-cover ring-2 ring-white/10"
                  />
                  <p className="truncate text-sm font-semibold text-white">{owner.display_name}</p>
                  <svg className="ml-auto h-4 w-4 text-white/30" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </button>
            ))}
            {owners.length === 0 && (
              <p className="py-4 text-center text-sm text-white/40">No avatars available.</p>
            )}
          </div>
        )}
      </>,
    )
  }

  // ---- Step: New user details (after selecting owner) ----
  if (step === 'new-user-details' && selectedOwner) {
    return panel(
      <>
        <h1 className="mb-2 text-center text-4xl font-bold tracking-tight text-white">{selectedOwner.display_name}</h1>
        <p className="mb-6 text-center text-sm text-white/60">{t(locale, 'enterYourDetails')}</p>

        {emailSent ? emailSentUI : (
          <form onSubmit={handleNewUserSubmit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="new-first" className="mb-2 block text-sm font-medium text-white/80">
                  {t(locale, 'firstName')}
                </label>
                <input
                  id="new-first"
                  type="text"
                  required
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                  placeholder="Juan"
                />
              </div>
              <div>
                <label htmlFor="new-last" className="mb-2 block text-sm font-medium text-white/80">
                  {t(locale, 'lastName')}
                </label>
                <input
                  id="new-last"
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
              <label htmlFor="new-email" className="mb-2 block text-sm font-medium text-white/80">
                {t(locale, 'email')}
              </label>
              <input
                id="new-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                placeholder="you@example.com"
              />
            </div>

            {authMode === 'password' && (
              <div>
                <label htmlFor="new-password" className="mb-2 block text-sm font-medium text-white/80">
                  {t(locale, 'password')}
                </label>
                <input
                  id="new-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/35 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                  placeholder={t(locale, 'passwordPlaceholder')}
                />
              </div>
            )}

            {error && (
              <p className="rounded-2xl border border-red-400/15 bg-red-500/15 px-4 py-3 text-sm text-red-200">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-2xl bg-[#00a884] py-3.5 font-semibold text-[#07141a] transition hover:brightness-110 disabled:opacity-50"
            >
              {loading
                ? (authMode === 'password' ? t(locale, 'signingIn') : t(locale, 'sending'))
                : (authMode === 'password' ? t(locale, 'signInWithPassword') : t(locale, 'sendVerificationEmail'))}
            </button>

            <button
              type="button"
              onClick={() => { setAuthMode(authMode === 'password' ? 'magic-link' : 'password'); setError(null) }}
              className="w-full text-center text-sm text-white/50 transition hover:text-white/80"
            >
              {authMode === 'password' ? t(locale, 'useMagicLink') : t(locale, 'usePassword')}
            </button>
          </form>
        )}
      </>,
    )
  }

  // Fallback
  return panel(
    <p className="text-center text-white/60">Something went wrong. Please refresh.</p>,
  )
}
