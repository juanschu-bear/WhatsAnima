import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

export default function Home() {
  const { user, signOut } = useAuth()

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#0b141a] px-4 text-white">
      <img
        src="/hero.png"
        alt="WhatsAnima"
        className="mb-6 w-full max-w-[400px]"
      />
      <h1 className="text-5xl font-extrabold tracking-tight">WhatsAnima</h1>
      <p className="mt-4 text-xl opacity-80">Dein Anime-Universum wartet auf dich</p>
      <p className="mt-2 text-sm opacity-60">Angemeldet als {user?.email}</p>
      <div className="mt-6 flex gap-3">
        <Link
          to="/dashboard"
          className="rounded-lg bg-white px-6 py-2 text-sm font-semibold text-[#0b141a] transition hover:bg-white/90"
        >
          Dashboard
        </Link>
        <button
          onClick={signOut}
          className="rounded-lg border border-white/30 px-6 py-2 text-sm font-medium transition hover:bg-white/10"
        >
          Abmelden
        </button>
      </div>
    </div>
  )
}
