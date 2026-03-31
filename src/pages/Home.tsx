import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { findContactByEmail } from '../lib/api'

export default function Home() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [checking, setChecking] = useState(true)
  const [isOwner, setIsOwner] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [profileName, setProfileName] = useState('')
  const [savingAccount, setSavingAccount] = useState(false)
  const [accountMessage, setAccountMessage] = useState<string | null>(null)

  const displayName =
    profileName.trim() ||
    [user?.user_metadata?.first_name, user?.user_metadata?.last_name].filter(Boolean).join(' ') ||
    user?.user_metadata?.full_name ||
    user?.email ||
    'WhatsAnima'

  useEffect(() => {
    if (!user) return
    const initialName = String(
      user.user_metadata?.full_name ||
      [user.user_metadata?.first_name, user.user_metadata?.last_name].filter(Boolean).join(' ') ||
      user.email ||
      '',
    ).trim()
    setProfileName(initialName)
  }, [user])

  useEffect(() => {
    if (!user) {
      setChecking(false)
      return
    }

    // Check role and route accordingly
    async function routeByRole() {
      // Check if owner
      const { data: ownerData } = await supabase
        .from('wa_owners')
        .select('id')
        .eq('user_id', user!.id)
        .is('deleted_at', null)
        .maybeSingle()

      if (ownerData) {
        setIsOwner(true)
        setChecking(false)
        return
      }

      // Not an owner — check if they're a contact with an existing conversation
      if (user!.email) {
        try {
          const contact = await findContactByEmail(user!.email)
          if (contact) {
            // Find their most recent conversation
            const { data: conv } = await supabase
              .from('wa_conversations')
              .select('id')
              .eq('contact_id', contact.id)
              .order('updated_at', { ascending: false })
              .limit(1)
              .maybeSingle()

            if (conv) {
              navigate(`/chat/${conv.id}`, { replace: true })
              return
            }
          }
        } catch {
          // Fallback to avatar select
        }
      }

      // Contact without conversation — go to avatar select
      navigate('/avatars', { replace: true })
    }

    routeByRole().catch(() => setChecking(false))
  }, [user, navigate])

  async function saveAccount() {
    if (!user) return
    setSavingAccount(true)
    setAccountMessage(null)
    try {
      const nextName = profileName.trim()
      const currentEmail = String(user.email || '').trim()
      const payload: Record<string, unknown> = {
        data: {
          full_name: nextName || currentEmail || 'WhatsAnima User',
        },
      }

      const { error } = await supabase.auth.updateUser(payload)
      if (error) throw error

      setAccountMessage('Account saved.')
    } catch (saveError) {
      setAccountMessage(saveError instanceof Error ? saveError.message : 'Could not save account changes.')
    } finally {
      setSavingAccount(false)
    }
  }

  if (checking) {
    return (
      <div className="brand-scene flex min-h-screen items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-[#1f2c34] border-t-[#00a884]" />
      </div>
    )
  }

  // Only owners reach this point — show a welcome screen with Dashboard link
  return (
    <div className="brand-scene min-h-screen text-white">
      <div className="relative z-10 flex min-h-screen items-center justify-center px-6 py-12">
        <div className="mx-auto flex w-full max-w-5xl flex-col items-center text-center">
          <img
            src="/Icon.PNG"
            alt="WhatsAnima"
            className="w-full max-w-[220px] object-contain drop-shadow-[0_0_34px_rgba(93,236,214,0.42)] sm:max-w-[260px] md:max-w-[320px]"
          />
          <h1 className="brand-wordmark mt-8 text-5xl font-extrabold tracking-tight sm:text-6xl md:text-7xl">
            WhatsAnima
          </h1>
          <p className="brand-kicker mt-3 text-[11px] text-white/80 sm:text-sm">
            Observational Perception Messaging
          </p>
          <p className="mt-8 max-w-2xl text-lg text-white/80 sm:text-xl">
            Your AI twin is ready.
          </p>
          <div className="mt-5 w-full max-w-sm">
            <button
              type="button"
              onClick={() => setAccountOpen((current) => !current)}
              className="flex w-full items-center justify-between rounded-2xl border border-white/12 bg-white/[0.05] px-4 py-3 text-left text-white/85 backdrop-blur-xl transition hover:border-[#00a884]/40 hover:bg-white/[0.08]"
            >
              <span className="text-sm font-medium">Account</span>
              <span className="max-w-[62%] truncate text-sm text-white/70">{displayName}</span>
            </button>
            {accountOpen ? (
              <div className="mt-2 rounded-2xl border border-white/10 bg-[#0a141f]/95 p-4 text-left shadow-[0_25px_60px_rgba(0,0,0,0.35)] backdrop-blur-2xl">
                <label className="block text-[11px] uppercase tracking-[0.18em] text-white/45">
                  Name
                  <input
                    type="text"
                    value={profileName}
                    onChange={(event) => setProfileName(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-white/12 bg-[#08111a] px-3 py-2 text-sm text-white outline-none transition focus:border-[#00a884]/60"
                    placeholder="Your name"
                  />
                </label>
                <label className="mt-3 block text-[11px] uppercase tracking-[0.18em] text-white/45">
                  Email
                  <div className="mt-2 w-full rounded-xl border border-white/12 bg-[#08111a] px-3 py-2 text-sm text-white/75">
                    {String(user?.email || 'No email')}
                  </div>
                </label>
                {accountMessage ? (
                  <p className="mt-3 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/75">
                    {accountMessage}
                  </p>
                ) : null}
                <div className="mt-3 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setAccountOpen(false)}
                    className="rounded-xl border border-white/12 bg-white/[0.04] px-3 py-2 text-xs text-white/80 transition hover:bg-white/[0.08]"
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveAccount()}
                    disabled={savingAccount}
                    className="rounded-xl bg-[#00a884] px-3 py-2 text-xs font-semibold text-[#08111a] transition hover:brightness-110 disabled:opacity-60"
                  >
                    {savingAccount ? 'Saving...' : 'Save Account'}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          <div className="mt-8 flex w-full max-w-md flex-col gap-3">
            <button
              type="button"
              onClick={() => navigate('/avatars')}
              className="flex items-center justify-center gap-2 rounded-2xl bg-[#00a884] px-6 py-3 text-center text-sm font-semibold text-[#0b141a] transition hover:brightness-110"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              Chat
            </button>
            <div className="grid grid-cols-2 gap-3">
              {isOwner && (
                <button
                  type="button"
                  onClick={() => navigate('/dashboard')}
                  className="min-h-[52px] rounded-2xl border border-white/10 bg-[#1f2c34]/80 px-4 py-3 text-sm font-medium transition hover:border-[#00a884]/60 hover:text-[#00a884]"
                >
                  Dashboard
                </button>
              )}
              <button
                type="button"
                onClick={() => navigate('/perception')}
                className="min-h-[52px] rounded-2xl border border-white/10 bg-[#1f2c34]/80 px-4 py-3 text-sm font-medium transition hover:border-[#00a884]/60 hover:text-[#00a884]"
              >
                Perception
              </button>
              {isOwner && (
                <button
                  type="button"
                  onClick={() => navigate('/meeting-host')}
                  className="min-h-[52px] rounded-2xl border border-white/10 bg-[#1f2c34]/80 px-4 py-3 text-sm font-medium transition hover:border-[#00a884]/60 hover:text-[#00a884]"
                >
                  Meeting
                </button>
              )}
              <button
                type="button"
                onClick={() => navigate('/settings')}
                className="min-h-[52px] rounded-2xl border border-white/10 bg-[#1f2c34]/80 px-4 py-3 text-sm font-medium transition hover:border-[#00a884]/60 hover:text-[#00a884]"
              >
                Settings
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
