import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

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
      const inviteCode = String(user?.user_metadata?.invite_code || '').trim()
      if (inviteCode) {
        navigate('/onboarding', { replace: true })
        return
      }

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

      // Not an owner — find their most recent conversation via email
      if (user!.email) {
        try {
          const { data: contacts } = await supabase
            .from('wa_contacts')
            .select('id')
            .eq('email', user!.email)
          const contactIds = (contacts ?? []).map((c: { id: string }) => c.id)
          if (contactIds.length > 0) {
            const { data: conv } = await supabase
              .from('wa_conversations')
              .select('id')
              .in('contact_id', contactIds)
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
          <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-[#e0c87e]/15 bg-[#e0c87e]/5 px-4 py-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-[#e0c87e] animate-pulse" />
            <span className="text-[10px] font-medium uppercase tracking-[0.15em] text-[#e0c87e]/70">Beta</span>
          </div>
          <p className="mt-6 max-w-2xl text-lg text-white/80 sm:text-xl">
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
              className="flex items-center justify-center gap-2 rounded-2xl border border-white/15 bg-gradient-to-r from-[#1a2a30] via-[#1e3338] to-[#1a2a30] px-6 py-3.5 text-center text-sm font-semibold text-white shadow-[0_0_20px_rgba(45,212,191,0.1),inset_0_1px_0_rgba(255,255,255,0.08)] transition hover:shadow-[0_0_35px_rgba(45,212,191,0.2)] hover:border-[#2dd4bf]/30"
            >
              <svg className="h-5 w-5 text-[#5eead4]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
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
              {isOwner ? (
                <button
                  type="button"
                  onClick={() => navigate('/perception')}
                  className="min-h-[52px] rounded-2xl border border-white/10 bg-[#1f2c34]/80 px-4 py-3 text-sm font-medium transition hover:border-[#00a884]/60 hover:text-[#00a884]"
                >
                  Perception
                </button>
              ) : (
                <div className="flex min-h-[52px] flex-col items-center justify-center rounded-2xl border border-white/6 bg-[#1f2c34]/40 px-4 py-3 text-sm font-medium text-white/25">
                  Perception
                  <span className="text-[10px] font-normal text-white/15">Avatar owners only</span>
                </div>
              )}
              {isOwner && (
                <button
                  type="button"
                  onClick={() => navigate('/meeting-host')}
                  className="min-h-[52px] rounded-2xl border border-white/10 bg-[#1f2c34]/80 px-4 py-3 text-sm font-medium transition hover:border-[#00a884]/60 hover:text-[#00a884]"
                >
                  Meeting
                </button>
              )}
              {!isOwner && (
                <div className="flex min-h-[52px] flex-col items-center justify-center rounded-2xl border border-white/6 bg-[#1f2c34]/40 px-4 py-3 text-sm font-medium text-white/25">
                  Meeting
                  <span className="text-[10px] font-normal text-white/15">Available soon</span>
                </div>
              )}
              <button
                type="button"
                onClick={() => navigate('/readouts')}
                className="min-h-[52px] rounded-2xl border border-[#d4b86a]/25 bg-gradient-to-r from-[#2a2418] via-[#332c1a] to-[#2a2418] px-4 py-3 text-sm font-medium text-[#f0d890] shadow-[0_0_18px_rgba(224,200,126,0.08),inset_0_1px_0_rgba(240,216,144,0.06)] transition hover:shadow-[0_0_30px_rgba(224,200,126,0.18)] hover:border-[#e0c87e]/40 hover:text-[#f5e4a8]"
              >
                Insights
                <span className="ml-2 text-[9px] uppercase tracking-wider text-[#c0c8d0]/50">Premium</span>
              </button>
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
