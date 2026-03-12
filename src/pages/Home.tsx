import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { findContactByEmail } from '../lib/api'

export default function Home() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [checking, setChecking] = useState(true)

  const displayName =
    [user?.user_metadata?.first_name, user?.user_metadata?.last_name].filter(Boolean).join(' ') ||
    user?.email ||
    'WhatsAnima'

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
        .maybeSingle()

      if (ownerData) {
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
          <div className="mt-5 rounded-full border border-white/10 bg-white/5 px-5 py-2 text-sm text-white/70 backdrop-blur-xl">
            {displayName}
          </div>
          <div className="mt-8 flex w-full max-w-sm flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => navigate('/dashboard')}
              className="rounded-2xl bg-[#00a884] px-6 py-3 text-center text-sm font-semibold text-[#0b141a] transition hover:brightness-110"
            >
              Dashboard
            </button>
            <button
              type="button"
              onClick={() => navigate('/settings')}
              className="rounded-2xl border border-white/10 bg-[#1f2c34]/80 px-6 py-3 text-sm font-medium transition hover:border-[#00a884]/60 hover:text-[#00a884]"
            >
              Settings
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
