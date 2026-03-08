import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

export default function Home() {
  const { user, signOut } = useAuth()

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#0b141a] px-6 text-white">
      <img
        src="/hero.png"
        alt="WhatsAnima"
        className="mb-8 w-full max-w-[320px] object-contain"
      />
      <h1 className="text-5xl font-extrabold tracking-tight">WhatsAnima</h1>
      <p className="mt-4 text-xl text-white/80">Your AI twin is ready.</p>
      <p className="mt-3 text-sm text-white/60">{user?.email}</p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Link
          to="/dashboard"
          className="rounded-2xl bg-[#00a884] px-6 py-3 text-center text-sm font-semibold text-[#0b141a] transition hover:brightness-110"
        >
          Dashboard
        </Link>
        <button
          onClick={signOut}
          className="rounded-2xl border border-white/10 bg-[#1f2c34] px-6 py-3 text-sm font-medium transition hover:border-[#00a884]/60 hover:text-[#00a884]"
        >
          Sign Out
        </button>
      </div>
    </div>
  )
}
