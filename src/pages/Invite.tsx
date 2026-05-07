import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { createOnboardingInvitation, listAllOwners } from '../lib/api'
import { supabase } from '../lib/supabase'

type AvatarOption = {
  id: string
  display_name: string
}

export default function Invite() {
  const { user } = useAuth()
  const [ownerId, setOwnerId] = useState<string | null>(null)
  const [avatars, setAvatars] = useState<AvatarOption[]>([])
  const [selectedAvatarIds, setSelectedAvatarIds] = useState<Set<string>>(new Set())

  const [inviteeName, setInviteeName] = useState('')
  const [inviteeEmail, setInviteeEmail] = useState('')
  const [language, setLanguage] = useState('en')

  const [inviteUrl, setInviteUrl] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!user?.id) return

    void (async () => {
      const [{ data: owner }, owners] = await Promise.all([
        supabase
          .from('wa_owners')
          .select('id')
          .eq('user_id', user.id)
          .is('deleted_at', null)
          .maybeSingle(),
        listAllOwners(),
      ])

      setOwnerId(String(owner?.id || '').trim() || null)
      const options = (owners ?? [])
        .map((row: any) => ({
          id: String(row.id || '').trim(),
          display_name: String(row.display_name || '').trim(),
        }))
        .filter((row: AvatarOption) => row.id && row.display_name)
      setAvatars(options)
      if (options.length > 0) {
        setSelectedAvatarIds(new Set([options[0].id]))
      }
    })()
  }, [user?.id])

  const selectedAvatarNames = useMemo(
    () => avatars.filter((avatar) => selectedAvatarIds.has(avatar.id)).map((avatar) => avatar.display_name),
    [avatars, selectedAvatarIds],
  )

  function toggleAvatar(avatarId: string) {
    setSelectedAvatarIds((current) => {
      const next = new Set(current)
      if (next.has(avatarId)) {
        next.delete(avatarId)
      } else {
        next.add(avatarId)
      }
      return next
    })
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!ownerId) {
      setError('Owner profile not found. Please complete your owner setup first.')
      return
    }
    if (!inviteeName.trim() || selectedAvatarNames.length === 0) {
      setError('Invitee name and at least one avatar are required.')
      return
    }

    setCreating(true)
    setError(null)
    setInviteUrl('')

    try {
      const payload = await createOnboardingInvitation({
        inviterId: ownerId,
        inviteeName: inviteeName.trim(),
        inviteeEmail: inviteeEmail.trim() || null,
        allowedAvatars: selectedAvatarNames,
        language,
      })
      setInviteUrl(payload.inviteUrl)
      try {
        await navigator.clipboard.writeText(payload.inviteUrl)
      } catch {
        // Clipboard not available in all browser contexts.
      }
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not create invitation.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="brand-scene min-h-screen text-white">
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-3xl items-center justify-center px-6 py-10">
        <div className="brand-panel w-full rounded-[30px] p-8 sm:p-10">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-3xl font-bold tracking-tight">Create Invitation</h1>
            <Link to="/dashboard" className="text-sm text-[#58e3c7] hover:text-[#00a884]">
              Back to dashboard
            </Link>
          </div>
          <p className="mt-2 text-sm text-white/65">
            Invite a user and choose exactly which avatars they can access.
          </p>

          <form onSubmit={onSubmit} className="mt-8 space-y-6">
            <div>
              <label className="mb-2 block text-sm font-medium text-white/80">Invitee name</label>
              <input
                value={inviteeName}
                onChange={(event) => setInviteeName(event.target.value)}
                required
                className="brand-inset w-full rounded-2xl px-4 py-3 text-white outline-none focus:border-[#00a884]"
                placeholder="Geordi"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-white/80">Invitee email (optional)</label>
              <input
                value={inviteeEmail}
                onChange={(event) => setInviteeEmail(event.target.value)}
                type="email"
                className="brand-inset w-full rounded-2xl px-4 py-3 text-white outline-none focus:border-[#00a884]"
                placeholder="geordi@example.com"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-white/80">Language</label>
              <select
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
                className="brand-inset w-full rounded-2xl px-4 py-3 text-white outline-none focus:border-[#00a884]"
              >
                <option value="en">English</option>
                <option value="de">Deutsch</option>
                <option value="es">Español</option>
              </select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-white/80">Allowed avatars</label>
              <div className="grid gap-2 sm:grid-cols-2">
                {avatars.map((avatar) => {
                  const checked = selectedAvatarIds.has(avatar.id)
                  return (
                    <label
                      key={avatar.id}
                      className={`cursor-pointer rounded-2xl border px-4 py-3 text-sm transition ${
                        checked
                          ? 'border-[#00a884]/70 bg-[#00a884]/15 text-white'
                          : 'border-white/10 bg-[#102029]/70 text-white/80 hover:border-[#00a884]/35'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleAvatar(avatar.id)}
                        className="mr-3"
                      />
                      {avatar.display_name}
                    </label>
                  )
                })}
              </div>
            </div>

            {error ? (
              <p className="rounded-2xl border border-red-400/20 bg-red-500/15 px-4 py-3 text-sm text-red-200">{error}</p>
            ) : null}

            {inviteUrl ? (
              <div className="rounded-2xl border border-[#00a884]/35 bg-[#00a884]/10 px-4 py-4">
                <p className="text-sm font-medium text-[#7af4dd]">Invitation created</p>
                <p className="mt-2 break-all font-mono text-xs text-white/85">{inviteUrl}</p>
              </div>
            ) : null}

            <button
              type="submit"
              disabled={creating}
              className="w-full rounded-2xl bg-[#00a884] px-4 py-3 font-semibold text-[#08111a] transition hover:brightness-110 disabled:opacity-60"
            >
              {creating ? 'Creating…' : 'Create Invitation'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
