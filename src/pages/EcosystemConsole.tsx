import { useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { buildSsoLaunchUrl } from '../lib/sso'

function appUrl(envName: string, fallback: string): string {
  const value = (import.meta.env as any)?.[envName]
  return (value || fallback).replace(/\/+$/, '')
}

export default function EcosystemConsole() {
  const { session, user } = useAuth()
  const driveUrl = appUrl('VITE_ANIMA_DRIVE_URL', 'https://anima-drive-v1.vercel.app')
  const sheetsUrl = appUrl('VITE_ANIMA_SHEETS_URL', 'https://anima-sheets.vercel.app')
  const waUrl = appUrl('VITE_WHATSANIMA_URL', window.location.origin)

  const links = useMemo(() => ([
    {
      name: 'WhatsAnima',
      desc: 'Calls, voice and avatar interaction',
      href: buildSsoLaunchUrl(waUrl, session),
    },
    {
      name: 'Anima Drive',
      desc: 'Documents, extraction and CFO source data',
      href: buildSsoLaunchUrl(driveUrl, session),
    },
    {
      name: 'Anima Sheets',
      desc: 'Financial intelligence and operational views',
      href: buildSsoLaunchUrl(sheetsUrl, session),
    },
  ]), [waUrl, driveUrl, sheetsUrl, session])

  return (
    <div className="min-h-screen bg-[#060d12] text-white px-6 py-10">
      <div className="mx-auto max-w-6xl">
        <div className="rounded-3xl border border-white/10 bg-[radial-gradient(1200px_500px_at_10%_-10%,rgba(80,227,194,0.18),transparent),linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.01))] p-8 md:p-10">
          <h1 className="text-4xl md:text-5xl font-semibold tracking-tight">Anima Ecosystem</h1>
          <p className="mt-3 text-white/75 text-lg">
            One entry point for WhatsAnima, Drive and Sheets with session handoff.
          </p>
          <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-sm">
            <span className={`h-2.5 w-2.5 rounded-full ${session ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            {session ? `Signed in as ${user?.email || 'user'}` : 'No active session. Open Login first.'}
          </div>
        </div>

        <div className="mt-8 grid gap-5 md:grid-cols-3">
          {links.map((app) => (
            <a
              key={app.name}
              href={app.href}
              className="group rounded-3xl border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0.02))] p-6 transition-all hover:-translate-y-0.5 hover:border-emerald-300/35"
            >
              <div className="text-xl font-semibold">{app.name}</div>
              <div className="mt-2 text-sm text-white/70 min-h-10">{app.desc}</div>
              <div className="mt-6 text-emerald-300 text-sm font-medium">Open with SSO -></div>
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}
