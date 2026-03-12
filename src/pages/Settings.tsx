import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { type Locale, getStoredLocale, t } from '../lib/i18n'

export default function Settings() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [locale] = useState<Locale>(getStoredLocale)

  // Password form
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const displayName =
    [user?.user_metadata?.first_name, user?.user_metadata?.last_name]
      .filter(Boolean)
      .join(' ') || ''

  const email = user?.email ?? ''

  // Check if user has a password (providers array contains 'email' with password identity)
  const hasPassword = user?.app_metadata?.providers?.includes('email') ?? false

  function validatePassword(pw: string): string | null {
    if (pw.length < 8) return t(locale, 'passwordRequirements')
    if (!/[a-z]/.test(pw)) return t(locale, 'passwordRequirements')
    if (!/[A-Z]/.test(pw)) return t(locale, 'passwordRequirements')
    if (!/[0-9]/.test(pw)) return t(locale, 'passwordRequirements')
    return null
  }

  async function handleSetPassword(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    if (!newPassword) {
      setError(t(locale, 'passwordPlaceholder'))
      return
    }

    const validationError = validatePassword(newPassword)
    if (validationError) {
      setError(validationError)
      return
    }

    if (newPassword !== confirmPassword) {
      setError(t(locale, 'passwordMismatch'))
      return
    }

    setSaving(true)
    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
    })

    if (updateError) {
      setError(updateError.message)
      setSaving(false)
      return
    }

    setSuccess(t(locale, 'passwordUpdated'))
    setNewPassword('')
    setConfirmPassword('')
    setSaving(false)
  }

  async function handleSignOut() {
    await signOut()
    navigate('/login', { replace: true })
  }

  return (
    <div className="brand-scene min-h-screen">
      <div className="relative z-10 flex min-h-screen items-start justify-center px-4 pb-24 pt-10 sm:px-6 sm:pt-16">
        <div className="w-full max-w-md space-y-6">

          {/* Header */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-white/8 bg-white/[0.04] text-white/60 transition hover:border-white/20 hover:text-white"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h1 className="text-2xl font-bold text-white">{t(locale, 'settings')}</h1>
          </div>

          {/* Profile Card */}
          <div className="brand-panel rounded-[24px] p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-white/40">
              {t(locale, 'profile')}
            </h2>

            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[#00a884]/15 text-2xl font-bold text-[#00a884]">
                {(displayName || email).charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                {displayName && (
                  <p className="truncate text-lg font-semibold text-white">{displayName}</p>
                )}
                <p className="truncate text-sm text-white/50">{email}</p>
              </div>
            </div>
          </div>

          {/* Password Card */}
          <div className="brand-panel rounded-[24px] p-6">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-white/40">
              {t(locale, 'passwordSection')}
            </h2>
            <p className="mb-5 text-sm text-white/50">
              {hasPassword
                ? t(locale, 'passwordAlreadySet')
                : t(locale, 'passwordNotSet')}
            </p>

            <form onSubmit={handleSetPassword} className="space-y-4">
              <div>
                <label htmlFor="new-pw" className="mb-2 block text-sm font-medium text-white/70">
                  {t(locale, 'newPassword')}
                </label>
                <input
                  id="new-pw"
                  type="password"
                  value={newPassword}
                  onChange={(e) => { setNewPassword(e.target.value); setError(null); setSuccess(null) }}
                  className="brand-inset w-full rounded-2xl px-4 py-3.5 text-white placeholder-white/28 outline-none transition focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                  placeholder={t(locale, 'passwordPlaceholder')}
                  autoComplete="new-password"
                />
              </div>

              <div>
                <label htmlFor="confirm-pw" className="mb-2 block text-sm font-medium text-white/70">
                  {t(locale, 'confirmPassword')}
                </label>
                <input
                  id="confirm-pw"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => { setConfirmPassword(e.target.value); setError(null); setSuccess(null) }}
                  className="brand-inset w-full rounded-2xl px-4 py-3.5 text-white placeholder-white/28 outline-none transition focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                  placeholder={t(locale, 'confirmPassword')}
                  autoComplete="new-password"
                />
              </div>

              <p className="text-xs text-white/35">{t(locale, 'passwordRequirements')}</p>

              {error && (
                <p className="rounded-2xl border border-red-400/15 bg-red-500/15 px-4 py-3 text-sm text-red-200">
                  {error}
                </p>
              )}

              {success && (
                <p className="rounded-2xl border border-[#00a884]/20 bg-[#00a884]/10 px-4 py-3 text-sm text-[#00a884]">
                  {success}
                </p>
              )}

              <button
                type="submit"
                disabled={saving || !newPassword || !confirmPassword}
                className="w-full rounded-2xl bg-[#00a884] py-3.5 text-base font-semibold text-[#07141a] transition hover:brightness-110 disabled:opacity-40"
              >
                {saving ? t(locale, 'savingPassword') : t(locale, 'savePassword')}
              </button>
            </form>
          </div>

          {/* Sign Out */}
          <button
            type="button"
            onClick={handleSignOut}
            className="w-full rounded-[20px] border border-white/8 bg-white/[0.03] px-5 py-4 text-center text-sm font-medium text-red-400 transition hover:border-red-400/30 hover:bg-red-500/[0.06]"
          >
            {t(locale, 'signOut')}
          </button>

        </div>
      </div>
    </div>
  )
}
