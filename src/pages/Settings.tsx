import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { getOwnerByUserId, updateOwnerProfile, uploadOwnerAvatar, deleteOwnerAvatar } from '../lib/api'
import { type Locale, getStoredLocale, setStoredLocale, t } from '../lib/i18n'
import {
  type NotificationSound,
  NOTIFICATION_SOUNDS,
  getStoredSound,
  setStoredSound,
  playNotificationSound,
  subscribeToPush,
  unsubscribeFromPush,
  isPushSubscribed,
} from '../lib/notifications'

const APP_VERSION = '1.0.0'

interface OwnerSettings {
  privacy?: {
    readReceipts?: boolean
    onlineVisibility?: 'everyone' | 'contacts' | 'nobody'
  }
  notifications?: {
    push?: boolean
    sound?: boolean
  }
  chat?: {
    fontSize?: 'small' | 'medium' | 'large'
  }
}

export default function Settings() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [locale, setLocale] = useState<Locale>(getStoredLocale)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Owner data
  const [ownerId, setOwnerId] = useState<string | null>(null)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [statusBio, setStatusBio] = useState('')

  // Name editing
  const [firstName, setFirstName] = useState(user?.user_metadata?.first_name ?? '')
  const [lastName, setLastName] = useState(user?.user_metadata?.last_name ?? '')
  const [editingName, setEditingName] = useState(false)
  const [savingName, setSavingName] = useState(false)
  const [nameSuccess, setNameSuccess] = useState<string | null>(null)

  // Avatar upload
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [photoMessage, setPhotoMessage] = useState<string | null>(null)

  // Settings state
  const [ownerSettings, setOwnerSettings] = useState<OwnerSettings>({
    privacy: { readReceipts: true, onlineVisibility: 'everyone' },
    notifications: { push: true, sound: true },
    chat: { fontSize: 'medium' },
  })

  // Notification sound
  const [selectedSound, setSelectedSound] = useState<NotificationSound>(getStoredSound)
  const [pushSubscribed, setPushSubscribed] = useState(false)
  const [pushLoading, setPushLoading] = useState(false)

  // Check push subscription status on mount
  useEffect(() => {
    isPushSubscribed().then(setPushSubscribed)
  }, [])

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
        if (owner.settings && typeof owner.settings === 'object') {
          setOwnerSettings((prev) => ({ ...prev, ...(owner.settings as OwnerSettings) }))
        }
        if (owner.system_prompt) setStatusBio(owner.system_prompt)
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
    setPhotoMessage(null)
    setError(null)
    try {
      const url = await uploadOwnerAvatar(ownerId, file)
      await updateOwnerProfile(ownerId, { avatar_url: url })
      setAvatarUrl(url + '?t=' + Date.now())
      setPhotoMessage(t(locale, 'photoUpdated'))
      setTimeout(() => setPhotoMessage(null), 3000)
    } catch (err: any) {
      console.error('[Settings] Photo upload error:', err)
      setError(err?.message || t(locale, 'uploadFailed'))
    } finally {
      setUploadingPhoto(false)
    }
  }

  async function handleRemovePhoto() {
    if (!ownerId) return
    setUploadingPhoto(true)
    try {
      await deleteOwnerAvatar(ownerId)
      await updateOwnerProfile(ownerId, { avatar_url: null })
      setAvatarUrl(null)
      setPhotoMessage(t(locale, 'photoRemoved'))
      setTimeout(() => setPhotoMessage(null), 3000)
    } catch {
      setError(t(locale, 'uploadFailed'))
    } finally {
      setUploadingPhoto(false)
    }
  }

  async function persistSettings(patch: Partial<OwnerSettings>) {
    const merged = { ...ownerSettings, ...patch }
    setOwnerSettings(merged)
    if (!ownerId) return
    try {
      await updateOwnerProfile(ownerId, { settings: merged as Record<string, unknown> })
    } catch {
      /* silent — settings are also in local state */
    }
  }

  function handleLocaleChange(newLocale: Locale) {
    setLocale(newLocale)
    setStoredLocale(newLocale)
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
    if (!newPassword) { setError(t(locale, 'passwordPlaceholder')); return }
    const validationError = validatePassword(newPassword)
    if (validationError) { setError(validationError); return }
    if (newPassword !== confirmPassword) { setError(t(locale, 'passwordMismatch')); return }
    setSaving(true)
    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword })
    if (updateError) { setError(updateError.message); setSaving(false); return }
    setSuccess(t(locale, 'passwordUpdated'))
    setNewPassword('')
    setConfirmPassword('')
    setSaving(false)
  }

  async function handleSignOut() {
    await signOut()
    navigate('/login', { replace: true })
  }

  const L = (key: Parameters<typeof t>[1]) => t(locale, key)

  return (
    <div className="brand-scene min-h-screen">
      <div className="relative z-10 flex min-h-screen items-start justify-center px-4 pb-24 pt-[calc(env(safe-area-inset-top)+2.5rem)] sm:px-6">
        <div className="w-full max-w-md space-y-5">

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
            <h1 className="text-2xl font-bold text-white">{L('settings')}</h1>
          </div>

          {/* ═══════════ PROFILE ═══════════ */}
          <div className="brand-panel rounded-[24px] p-6">
            {/* Large avatar centered */}
            <div className="flex flex-col items-center">
              <div className="relative">
                <div className="flex h-28 w-28 items-center justify-center overflow-hidden rounded-full bg-[#00a884]/15 shadow-[0_0_48px_rgba(0,168,132,0.18)]">
                  {avatarUrl ? (
                    <img src={avatarUrl} alt="Profile" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-5xl font-bold text-[#00a884]">
                      {(displayName || email).charAt(0).toUpperCase()}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingPhoto}
                  className="absolute -bottom-1 -right-1 flex h-10 w-10 items-center justify-center rounded-full border-2 border-[#0b141a] bg-[#00a884] text-white shadow-lg transition hover:brightness-110 disabled:opacity-50"
                  title={L('changePhoto')}
                >
                  {uploadingPhoto ? (
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  ) : (
                    <svg className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
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
              {avatarUrl && (
                <button type="button" onClick={() => void handleRemovePhoto()} disabled={uploadingPhoto} className="mt-2 text-xs text-red-400/70 transition hover:text-red-400">
                  {L('removePhoto')}
                </button>
              )}
              {photoMessage && <p className="mt-2 text-xs text-[#00a884]">{photoMessage}</p>}
            </div>

            {/* Name — editable */}
            <div className="mt-5 space-y-3">
              {editingName ? (
                <>
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label htmlFor="s-fn" className="mb-1 block text-xs text-white/50">{L('firstName')}</label>
                      <input id="s-fn" type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)}
                        className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/28 outline-none transition focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20" />
                    </div>
                    <div className="flex-1">
                      <label htmlFor="s-ln" className="mb-1 block text-xs text-white/50">{L('lastName')}</label>
                      <input id="s-ln" type="text" value={lastName} onChange={(e) => setLastName(e.target.value)}
                        className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/28 outline-none transition focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20" />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => { setEditingName(false); setFirstName(user?.user_metadata?.first_name ?? ''); setLastName(user?.user_metadata?.last_name ?? '') }}
                      className="flex-1 rounded-2xl border border-white/10 py-2.5 text-sm text-white/60 transition hover:border-white/20">{L('back')}</button>
                    <button type="button" onClick={() => void handleSaveName()} disabled={savingName}
                      className="flex-1 rounded-2xl bg-[#00a884] py-2.5 text-sm font-semibold text-[#07141a] transition hover:brightness-110 disabled:opacity-40">
                      {savingName ? '...' : L('saveName')}
                    </button>
                  </div>
                </>
              ) : (
                <button type="button" onClick={() => setEditingName(true)}
                  className="flex w-full items-center justify-between rounded-2xl border border-white/6 bg-white/[0.02] px-4 py-3.5 text-left transition hover:border-white/12">
                  <div className="min-w-0">
                    <p className="truncate text-lg font-semibold text-white">{displayName || L('editName')}</p>
                    <p className="text-xs text-white/40">{L('editName')}</p>
                  </div>
                  <svg className="h-4 w-4 shrink-0 text-white/30" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
              )}
              {nameSuccess && (
                <p className="rounded-2xl border border-[#00a884]/20 bg-[#00a884]/10 px-4 py-2.5 text-sm text-[#00a884]">{nameSuccess}</p>
              )}
            </div>

            {/* Email (read-only) */}
            <div className="mt-3 rounded-2xl border border-white/6 bg-white/[0.02] px-4 py-3.5">
              <p className="text-xs text-white/40">{L('email')}</p>
              <p className="mt-0.5 truncate text-sm text-white/70">{email}</p>
            </div>

            {/* Status / Bio */}
            <div className="mt-3">
              <label htmlFor="s-bio" className="mb-1 block text-xs text-white/40">{L('statusBio')}</label>
              <input
                id="s-bio"
                type="text"
                value={statusBio}
                onChange={(e) => setStatusBio(e.target.value)}
                onBlur={() => {
                  if (!ownerId) return
                  void updateOwnerProfile(ownerId, {} as Record<string, never>).catch(() => {})
                }}
                placeholder={L('statusBioPlaceholder')}
                className="brand-inset w-full rounded-2xl px-4 py-3 text-sm text-white placeholder-white/28 outline-none transition focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
              />
            </div>
          </div>

          {/* ═══════════ ACCOUNT ═══════════ */}
          <div className="brand-panel rounded-[24px] p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-white/40">{L('accountSection')}</h2>

            {/* Password */}
            <div className="space-y-4">
              <p className="text-xs text-white/50">
                {hasPassword ? L('passwordAlreadySet') : L('passwordNotSet')}
              </p>
              <form onSubmit={handleSetPassword} className="space-y-3">
                <input id="new-pw" type="password" value={newPassword}
                  onChange={(e) => { setNewPassword(e.target.value); setError(null); setSuccess(null) }}
                  className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/28 outline-none transition focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                  placeholder={L('newPassword')} autoComplete="new-password" />
                <input id="confirm-pw" type="password" value={confirmPassword}
                  onChange={(e) => { setConfirmPassword(e.target.value); setError(null); setSuccess(null) }}
                  className="brand-inset w-full rounded-2xl px-4 py-3 text-white placeholder-white/28 outline-none transition focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                  placeholder={L('confirmPassword')} autoComplete="new-password" />
                <p className="text-[11px] text-white/30">{L('passwordRequirements')}</p>
                {error && <p className="rounded-2xl border border-red-400/15 bg-red-500/15 px-4 py-2.5 text-sm text-red-200">{error}</p>}
                {success && <p className="rounded-2xl border border-[#00a884]/20 bg-[#00a884]/10 px-4 py-2.5 text-sm text-[#00a884]">{success}</p>}
                <button type="submit" disabled={saving || !newPassword || !confirmPassword}
                  className="w-full rounded-2xl bg-[#00a884] py-3 text-sm font-semibold text-[#07141a] transition hover:brightness-110 disabled:opacity-40">
                  {saving ? L('savingPassword') : L('savePassword')}
                </button>
              </form>
            </div>

            {/* 2FA */}
            <div className="mt-5 flex items-center justify-between rounded-2xl border border-white/6 bg-white/[0.02] px-4 py-3.5">
              <div>
                <p className="text-sm font-medium text-white">{L('twoFactorAuth')}</p>
                <p className="text-xs text-white/40">{L('twoFactorDesc')}</p>
              </div>
              <span className="rounded-full bg-white/[0.06] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-white/35">{L('comingSoon')}</span>
            </div>

            {/* Delete account */}
            <button type="button" className="mt-4 w-full rounded-2xl border border-red-400/10 bg-red-500/[0.04] px-4 py-3.5 text-left text-sm text-red-400/70 transition hover:border-red-400/25 hover:text-red-400">
              {L('deleteAccount')}
            </button>
          </div>

          {/* ═══════════ PRIVACY ═══════════ */}
          <div className="brand-panel rounded-[24px] p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-white/40">{L('privacySection')}</h2>

            {/* Read Receipts */}
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm font-medium text-white">{L('readReceipts')}</p>
                <p className="text-xs text-white/40">{L('readReceiptsDesc')}</p>
              </div>
              <button type="button" onClick={() => void persistSettings({ privacy: { ...ownerSettings.privacy, readReceipts: !ownerSettings.privacy?.readReceipts } })}
                className={`relative h-7 w-12 rounded-full transition ${ownerSettings.privacy?.readReceipts ? 'bg-[#00a884]' : 'bg-white/15'}`}>
                <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${ownerSettings.privacy?.readReceipts ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </button>
            </div>

            {/* Online Status */}
            <div className="mt-3 border-t border-white/6 pt-3">
              <p className="text-sm font-medium text-white">{L('onlineStatus')}</p>
              <p className="mb-3 text-xs text-white/40">{L('onlineStatusDesc')}</p>
              <div className="flex gap-2">
                {(['everyone', 'contacts', 'nobody'] as const).map((opt) => (
                  <button key={opt} type="button"
                    onClick={() => void persistSettings({ privacy: { ...ownerSettings.privacy, onlineVisibility: opt } })}
                    className={`flex-1 rounded-xl py-2 text-xs font-medium transition ${
                      ownerSettings.privacy?.onlineVisibility === opt
                        ? 'bg-[#00a884] text-[#07141a]'
                        : 'border border-white/8 text-white/50 hover:border-white/20'
                    }`}>
                    {opt === 'everyone' ? L('everyone') : opt === 'contacts' ? L('contactsOnly') : L('nobody')}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* ═══════════ NOTIFICATIONS ═══════════ */}
          <div className="brand-panel rounded-[24px] p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-white/40">{L('notificationsSection')}</h2>

            {/* Push */}
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm font-medium text-white">{L('pushNotifications')}</p>
                <p className="text-xs text-white/40">{L('pushNotificationsDesc')}</p>
              </div>
              <button
                type="button"
                disabled={pushLoading}
                onClick={async () => {
                  setPushLoading(true)
                  try {
                    if (pushSubscribed) {
                      await unsubscribeFromPush(user?.id ?? '')
                      setPushSubscribed(false)
                      void persistSettings({ notifications: { ...ownerSettings.notifications, push: false } })
                    } else {
                      const ok = await subscribeToPush(user?.id ?? '')
                      setPushSubscribed(ok)
                      if (ok) void persistSettings({ notifications: { ...ownerSettings.notifications, push: true } })
                    }
                  } finally {
                    setPushLoading(false)
                  }
                }}
                className={`relative h-7 w-12 rounded-full transition ${pushSubscribed ? 'bg-[#00a884]' : 'bg-white/15'} ${pushLoading ? 'opacity-50' : ''}`}
              >
                <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${pushSubscribed ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </button>
            </div>

            {/* Sound toggle */}
            <div className="mt-2 flex items-center justify-between border-t border-white/6 py-3">
              <div>
                <p className="text-sm font-medium text-white">{L('messageSound')}</p>
                <p className="text-xs text-white/40">{L('messageSoundDesc')}</p>
              </div>
              <button type="button" onClick={() => void persistSettings({ notifications: { ...ownerSettings.notifications, sound: !ownerSettings.notifications?.sound } })}
                className={`relative h-7 w-12 rounded-full transition ${ownerSettings.notifications?.sound ? 'bg-[#00a884]' : 'bg-white/15'}`}>
                <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${ownerSettings.notifications?.sound ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </button>
            </div>

            {/* Sound picker */}
            {ownerSettings.notifications?.sound !== false && (
              <div className="mt-2 border-t border-white/6 pt-3">
                <p className="mb-2 text-sm font-medium text-white">{L('notificationTone')}</p>
                <div className="flex gap-2">
                  {NOTIFICATION_SOUNDS.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        setSelectedSound(s.id)
                        setStoredSound(s.id)
                        playNotificationSound(s.id)
                      }}
                      className={`flex-1 rounded-xl py-2.5 text-xs font-medium transition ${
                        selectedSound === s.id
                          ? 'bg-[#00a884] text-[#07141a]'
                          : 'border border-white/8 text-white/50 hover:border-white/20'
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ═══════════ CHAT SETTINGS ═══════════ */}
          <div className="brand-panel rounded-[24px] p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-white/40">{L('chatSettingsSection')}</h2>

            {/* Language */}
            <div className="mb-4">
              <p className="mb-2 text-sm font-medium text-white">{L('language')}</p>
              <div className="flex gap-2">
                {(['en', 'es', 'de'] as const).map((lang) => (
                  <button key={lang} type="button" onClick={() => handleLocaleChange(lang)}
                    className={`flex-1 rounded-xl py-2.5 text-xs font-semibold uppercase transition ${
                      locale === lang
                        ? 'bg-[#00a884] text-[#07141a]'
                        : 'border border-white/8 text-white/50 hover:border-white/20'
                    }`}>
                    {lang === 'en' ? 'EN' : lang === 'es' ? 'ES' : 'DE'}
                  </button>
                ))}
              </div>
            </div>

            {/* Font Size */}
            <div className="border-t border-white/6 pt-4">
              <p className="mb-2 text-sm font-medium text-white">{L('fontSize')}</p>
              <div className="flex gap-2">
                {(['small', 'medium', 'large'] as const).map((size) => (
                  <button key={size} type="button"
                    onClick={() => void persistSettings({ chat: { ...ownerSettings.chat, fontSize: size } })}
                    className={`flex-1 rounded-xl py-2.5 transition ${
                      ownerSettings.chat?.fontSize === size
                        ? 'bg-[#00a884] text-[#07141a]'
                        : 'border border-white/8 text-white/50 hover:border-white/20'
                    } ${size === 'small' ? 'text-[11px]' : size === 'medium' ? 'text-xs' : 'text-sm'} font-medium`}>
                    {size === 'small' ? L('fontSizeSmall') : size === 'medium' ? L('fontSizeMedium') : L('fontSizeLarge')}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* ═══════════ ABOUT ═══════════ */}
          <div className="brand-panel rounded-[24px] p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-white/40">{L('aboutSection')}</h2>

            <div className="space-y-1">
              <div className="flex items-center justify-between rounded-2xl px-1 py-2">
                <span className="text-sm text-white/60">{L('appVersion')}</span>
                <span className="text-sm font-medium text-white/40">{APP_VERSION}</span>
              </div>
              <a href="/privacy" target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-between rounded-2xl px-1 py-2 transition hover:bg-white/[0.03]">
                <span className="text-sm text-white/60">{L('privacyPolicy')}</span>
                <svg className="h-4 w-4 text-white/25" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </a>
              <a href="/terms" target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-between rounded-2xl px-1 py-2 transition hover:bg-white/[0.03]">
                <span className="text-sm text-white/60">{L('termsOfService')}</span>
                <svg className="h-4 w-4 text-white/25" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </a>
            </div>
          </div>

          {/* ═══════════ SIGN OUT ═══════════ */}
          <button type="button" onClick={handleSignOut}
            className="w-full rounded-[20px] border border-white/8 bg-white/[0.03] px-5 py-4 text-center text-sm font-medium text-red-400 transition hover:border-red-400/30 hover:bg-red-500/[0.06]">
            {L('signOut')}
          </button>

          <div className="h-6" />
        </div>
      </div>
    </div>
  )
}
