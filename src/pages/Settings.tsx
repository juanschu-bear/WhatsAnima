import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { getOwnerByUserId, updateOwnerProfile, uploadOwnerAvatar } from '../lib/api'
import { type Locale, getStoredLocale, t } from '../lib/i18n'

export default function Settings() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [locale] = useState<Locale>(getStoredLocale)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Owner data
  const [ownerId, setOwnerId] = useState<string | null>(null)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)

  // Name editing
  const [firstName, setFirstName] = useState(user?.user_metadata?.first_name ?? '')
  const [lastName, setLastName] = useState(user?.user_metadata?.last_name ?? '')
  const [editingName, setEditingName] = useState(false)
  const [savingName, setSavingName] = useState(false)
  const [nameSuccess, setNameSuccess] = useState<string | null>(null)

  // Avatar upload
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [photoSuccess, setPhotoSuccess] = useState<string | null>(null)

  // Password form
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const displayName = [firstName, lastName].filter(Boolean).join(' ') || ''
  const email = user?.email ?? ''

  const hasPassword = user?.app_metadata?.providers?.includes('email') ?? false

  // Load owner data on mount
  useEffect(() => {
    if (!user?.id) return
    getOwnerByUserId(user.id)
      .then((owner) => {
        setOwnerId(owner.id)
        if (owner.avatar_url) setAvatarUrl(owner.avatar_url)
        if (owner.display_name) {
          const parts = owner.display_name.split(' ')
          if (!firstName && parts[0]) setFirstName(parts[0])
          if (!lastName && parts.length > 1) setLastName(parts.slice(1).join(' '))
        }
      })
      .catch(() => { /* owner may not exist yet */ })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  async function handleSaveName() {
    if (!ownerId) return
    setSavingName(true)
    setNameSuccess(null)
    try {
      const newDisplayName = [firstName.trim(), lastName.trim()].filter(Boolean).join(' ')
      await updateOwnerProfile(ownerId, { display_name: newDisplayName })
      await supabase.auth.updateUser({
        data: { first_name: firstName.trim(), last_name: lastName.trim() },
      })
      setEditingName(false)
      setNameSuccess(t(locale, 'nameUpdated'))
      setTimeout(() => setNameSuccess(null), 3000)
    } catch {
      setError('Failed to update name.')
    } finally {
      setSavingName(false)
    }
  }

  async function handlePhotoUpload(file: File) {
    if (!ownerId) return
    setUploadingPhoto(true)
    setPhotoSuccess(null)
    try {
      const url = await uploadOwnerAvatar(ownerId, file)
      await updateOwnerProfile(ownerId, { avatar_url: url })
      setAvatarUrl(url + '?t=' + Date.now())
      setPhotoSuccess(t(locale, 'photoUpdated'))
      setTimeout(() => setPhotoSuccess(null), 3000)
    } catch {
      setError(t(locale, 'uploadFailed'))
    } finally {
      setUploadingPhoto(false)
    }
  }

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

          {/* Profile Card — WhatsApp/Telegram style */}
          <div className="brand-panel rounded-[24px] p-6">
            <h2 className="mb-5 text-sm font-semibold uppercase tracking-wider text-white/40">
              {t(locale, 'profile')}
            </h2>

            {/* Large avatar */}
            <div className="flex flex-col items-center">
              <div className="relative">
                <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full bg-[#00a884]/15 shadow-[0_0_40px_rgba(0,168,132,0.18)]">
                  {avatarUrl ? (
                    <img src={avatarUrl} alt="Profile" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-4xl font-bold text-[#00a884]">
                      {(displayName || email).charAt(0).toUpperCase()}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingPhoto}
                  className="absolute -bottom-1 -right-1 flex h-9 w-9 items-center justify-center rounded-full border-2 border-[#0b141a] bg-[#00a884] text-white shadow-lg transition hover:brightness-110 disabled:opacity-50"
                  title={t(locale, 'changePhoto')}
                >
                  {uploadingPhoto ? (
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  ) : (
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                  )}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) void handlePhotoUpload(file)
                    e.target.value = ''
                  }}
                />
              </div>
              {photoSuccess && (
                <p className="mt-2 text-xs text-[#00a884]">{photoSuccess}</p>
              )}
            </div>

            {/* Editable name */}
            <div className="mt-6 space-y-3">
              {editingName ? (
                <>
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label htmlFor="settings-first" className="mb-1 block text-xs text-white/50">{t(locale, 'firstName')}</label>
                      <input
                        id="settings-first"
                        type="text"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/28 outline-none transition focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                      />
                    </div>
                    <div className="flex-1">
                      <label htmlFor="settings-last" className="mb-1 block text-xs text-white/50">{t(locale, 'lastName')}</label>
                      <input
                        id="settings-last"
                        type="text"
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/28 outline-none transition focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingName(false)
                        setFirstName(user?.user_metadata?.first_name ?? '')
                        setLastName(user?.user_metadata?.last_name ?? '')
                      }}
                      className="flex-1 rounded-2xl border border-white/10 py-2.5 text-sm text-white/60 transition hover:border-white/20"
                    >
                      {t(locale, 'back')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSaveName()}
                      disabled={savingName}
                      className="flex-1 rounded-2xl bg-[#00a884] py-2.5 text-sm font-semibold text-[#07141a] transition hover:brightness-110 disabled:opacity-40"
                    >
                      {savingName ? '...' : t(locale, 'saveName')}
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingName(true)}
                  className="flex w-full items-center justify-between rounded-2xl border border-white/6 bg-white/[0.02] px-4 py-3.5 text-left transition hover:border-white/12"
                >
                  <div className="min-w-0">
                    <p className="truncate text-lg font-semibold text-white">
                      {displayName || t(locale, 'editName')}
                    </p>
                    <p className="text-xs text-white/40">{t(locale, 'editName')}</p>
                  </div>
                  <svg className="h-4 w-4 shrink-0 text-white/30" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
              )}
              {nameSuccess && (
                <p className="rounded-2xl border border-[#00a884]/20 bg-[#00a884]/10 px-4 py-2.5 text-sm text-[#00a884]">
                  {nameSuccess}
                </p>
              )}
            </div>

            {/* Email (read-only) */}
            <div className="mt-4 rounded-2xl border border-white/6 bg-white/[0.02] px-4 py-3.5">
              <p className="text-xs text-white/40">{t(locale, 'email')}</p>
              <p className="mt-0.5 truncate text-sm text-white/70">{email}</p>
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
