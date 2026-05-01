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
    <div className="min-h-screen bg-[#0b141a] text-white px-6 py-8">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-3xl font-bold">Anima Console</h1>
        <p className="mt-2 text-white/70">
          Unified launch and session handoff for your ecosystem.
          {user?.email ? ` Signed in as ${user.email}.` : ''}
        </p>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {links.map((app) => (
            <a
              key={app.name}
              href={app.href}
              className="rounded-2xl border border-white/15 bg-white/5 p-5 hover:bg-white/10 transition-colors"
            >
              <div className="text-lg font-semibold">{app.name}</div>
              <div className="mt-2 text-sm text-white/70">{app.desc}</div>
              <div className="mt-4 text-emerald-300 text-sm">Open -></div>
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}

