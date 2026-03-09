import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

export default function Home() {
  const { user, signOut } = useAuth()
  const ownerDisplay =
    [user?.user_metadata?.first_name, user?.user_metadata?.last_name].filter(Boolean).join(' ') ||
    user?.phone ||
    'WhatsAnima'

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
            {ownerDisplay}
          </div>
          <div className="mt-8 flex w-full max-w-sm flex-col gap-3 sm:flex-row">
            <Link
              to="/dashboard"
              className="rounded-2xl bg-[#00a884] px-6 py-3 text-center text-sm font-semibold text-[#0b141a] transition hover:brightness-110"
            >
              Dashboard
            </Link>
            <button
              onClick={signOut}
              className="rounded-2xl border border-white/10 bg-[#1f2c34]/80 px-6 py-3 text-sm font-medium transition hover:border-[#00a884]/60 hover:text-[#00a884]"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
