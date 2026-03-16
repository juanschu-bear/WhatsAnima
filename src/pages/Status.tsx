import { useEffect, useRef, useState } from 'react'

interface ServiceStatus {
  name: string
  current_status: 'ok' | 'fail' | 'degraded' | 'unknown'
  last_message: string | null
  last_check: string | null
  uptime_percent: number | null
  timeline: ('ok' | 'fail' | 'degraded' | 'no_data')[]
}

interface TooltipData {
  x: number
  y: number
  date: string
  status: string
  duration: string
}

interface Incident {
  id: string
  check_name: string
  started_at: string
  resolved_at: string | null
  message: string | null
  resolution_summary: string | null
}

interface StatusData {
  services: ServiceStatus[]
  incidents: Incident[]
}

const DISPLAY_NAMES: Record<string, string> = {
  db_schema: 'Database',
  opm: 'OPM',
  auth: 'Authentication',
  tts: 'Text-to-Speech',
  chat_api: 'Chat API',
  transcription: 'Transcription',
  tunnel_latency: 'Tunnel Latency',
  avatar_reply: 'Avatar Reply',
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function durationString(start: string, end: string | null): string {
  const endMs = end ? new Date(end).getTime() : Date.now()
  const diff = endMs - new Date(start).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ${mins % 60}m`
  const days = Math.floor(hrs / 24)
  return `${days}d ${hrs % 24}h`
}

const SLOT_COUNT = 84
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const SLOT_DURATION_MS = SEVEN_DAYS_MS / SLOT_COUNT

const STATUS_LABELS: Record<string, string> = {
  ok: 'Operational',
  degraded: 'Degraded',
  fail: 'Down',
  no_data: 'No data',
}

function slotTooltip(slotIndex: number, status: string): { date: string; statusLabel: string; duration: string } {
  const slotStart = new Date(Date.now() - SEVEN_DAYS_MS + slotIndex * SLOT_DURATION_MS)
  const slotEnd = new Date(slotStart.getTime() + SLOT_DURATION_MS)
  const fmt = (d: Date) =>
    d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return {
    date: `${fmt(slotStart)} – ${fmt(slotEnd)}`,
    statusLabel: STATUS_LABELS[status] || status,
    duration: '~2 hours',
  }
}

export default function Status() {
  const [data, setData] = useState<StatusData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tooltip, setTooltip] = useState<TooltipData | null>(null)
  const tooltipTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    fetch('/api/status-data')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((d) => { setData(d); setLoading(false) })
      .catch((e) => { setError(e.message); setLoading(false) })
  }, [])

  const allOk = data?.services.every((s) => s.current_status === 'ok' || s.current_status === 'degraded')
  const hasDegraded = data?.services.some((s) => s.current_status === 'degraded')
  const openIncidents = data?.incidents.filter((i) => !i.resolved_at) || []
  const resolvedIncidents = data?.incidents.filter((i) => i.resolved_at) || []
  const affectedServices = data?.services.filter((s) => s.current_status === 'fail' || s.current_status === 'degraded') || []

  function handleSlotHover(e: React.MouseEvent, slotIndex: number, status: string) {
    clearTimeout(tooltipTimeout.current)
    const rect = (e.target as HTMLElement).getBoundingClientRect()
    const info = slotTooltip(slotIndex, status)
    setTooltip({
      x: rect.left + rect.width / 2,
      y: rect.top - 8,
      date: info.date,
      status: info.statusLabel,
      duration: info.duration,
    })
  }

  function handleSlotLeave() {
    tooltipTimeout.current = setTimeout(() => setTooltip(null), 100)
  }

  return (
    <div className="min-h-[100dvh] bg-[linear-gradient(140deg,_#020a12_0%,_#071420_35%,_#060e1a_65%,_#030810_100%)] text-white">
      <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
        {/* Header */}
        <div className="mb-10 text-center">
          <a href="/" className="mb-4 inline-block">
            <img
              src="/Icon.PNG"
              alt="WhatsAnima"
              className="mx-auto h-12 w-auto object-contain drop-shadow-[0_0_22px_rgba(93,236,214,0.34)]"
            />
          </a>
          <h1 className="text-2xl font-bold tracking-tight">System Status</h1>

          {loading ? (
            <div className="mt-4 flex items-center justify-center gap-2 text-sm text-white/50">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white/60" />
              Checking services...
            </div>
          ) : error ? (
            <p className="mt-3 text-sm text-red-400">Unable to load status: {error}</p>
          ) : (
            <>
              <div className="mt-4 flex items-center justify-center gap-2">
                <span className={`inline-block h-3 w-3 rounded-full ${allOk && !hasDegraded ? 'bg-[#00a884] shadow-[0_0_8px_rgba(0,168,132,0.5)]' : allOk && hasDegraded ? 'bg-yellow-400 shadow-[0_0_8px_rgba(250,204,21,0.5)]' : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]'}`} />
                <span className="text-sm font-medium text-white/80">
                  {allOk && !hasDegraded ? 'All systems operational' : allOk && hasDegraded ? 'Some systems degraded' : 'Some systems are experiencing issues'}
                </span>
              </div>
              {affectedServices.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
                  {affectedServices.map((svc) => (
                    <span
                      key={svc.name}
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        svc.current_status === 'fail'
                          ? 'bg-red-500/10 text-red-400'
                          : 'bg-yellow-400/10 text-yellow-400'
                      }`}
                    >
                      <span className={`inline-block h-1.5 w-1.5 rounded-full ${svc.current_status === 'fail' ? 'bg-red-500' : 'bg-yellow-400'}`} />
                      {DISPLAY_NAMES[svc.name] || svc.name}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Service cards */}
        {data && (
          <div className="space-y-3">
            {data.services.map((svc) => (
              <div
                key={svc.name}
                className="rounded-2xl border border-white/[0.06] bg-[rgba(10,20,33,0.6)] px-5 py-4 backdrop-blur-sm"
              >
                {/* Top row: name + status */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span
                      className={`inline-block h-2.5 w-2.5 rounded-full ${
                        svc.current_status === 'ok'
                          ? 'bg-[#00a884] shadow-[0_0_6px_rgba(0,168,132,0.5)]'
                          : svc.current_status === 'degraded'
                            ? 'bg-yellow-400 shadow-[0_0_6px_rgba(250,204,21,0.5)]'
                            : svc.current_status === 'fail'
                              ? 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]'
                              : 'bg-white/25'
                      }`}
                    />
                    <span className="text-sm font-semibold">{DISPLAY_NAMES[svc.name] || svc.name}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    {svc.uptime_percent !== null && (
                      <span className={`text-xs font-medium ${svc.uptime_percent >= 99 ? 'text-[#00a884]' : svc.uptime_percent >= 95 ? 'text-yellow-400' : 'text-red-400'}`}>
                        {svc.uptime_percent}%
                      </span>
                    )}
                    <span className={`text-[10px] ${svc.current_status === 'ok' ? 'text-[#00a884]/70' : svc.current_status === 'degraded' ? 'text-yellow-400/70' : svc.current_status === 'fail' ? 'text-red-400/70' : 'text-white/30'}`}>
                      {svc.current_status === 'ok' ? 'Operational' : svc.current_status === 'degraded' ? 'Degraded' : svc.current_status === 'fail' ? 'Down' : 'Unknown'}
                    </span>
                  </div>
                </div>

                {/* Timeline bar */}
                <div className="mt-3 flex gap-px overflow-hidden rounded-md">
                  {svc.timeline.map((slot, i) => (
                    <div
                      key={i}
                      className={`h-[18px] flex-1 cursor-pointer transition-colors ${
                        slot === 'ok'
                          ? 'bg-[#00a884]/60 hover:bg-[#00a884]/80'
                          : slot === 'degraded'
                            ? 'bg-yellow-400/60 hover:bg-yellow-400/80'
                            : slot === 'fail'
                              ? 'bg-red-500/60 hover:bg-red-500/80'
                              : 'bg-white/[0.04] hover:bg-white/[0.08]'
                      }`}
                      onMouseEnter={(e) => handleSlotHover(e, i, slot)}
                      onMouseLeave={handleSlotLeave}
                    />
                  ))}
                </div>
                <div className="mt-1.5 flex justify-between text-[10px] text-white/30">
                  <span>7 days ago</span>
                  <span>{svc.last_check ? `Last check ${relativeTime(svc.last_check)}` : 'No data'}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Incidents */}
        {data && (openIncidents.length > 0 || resolvedIncidents.length > 0) && (
          <div className="mt-10">
            <h2 className="mb-4 text-lg font-bold tracking-tight">Incidents</h2>

            {openIncidents.length > 0 && (
              <div className="mb-4 space-y-2">
                {openIncidents.map((inc) => (
                  <div key={inc.id} className="rounded-2xl border border-red-500/20 bg-red-500/[0.06] px-5 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="inline-block h-2 w-2 rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]" />
                        <span className="text-sm font-semibold text-red-300">{DISPLAY_NAMES[inc.check_name] || inc.check_name}</span>
                      </div>
                      <span className="shrink-0 text-[10px] text-red-400/60">Ongoing — {durationString(inc.started_at, null)}</span>
                    </div>
                    {inc.message && <p className="mt-1.5 text-xs text-red-200/70">{inc.message}</p>}
                    <p className="mt-1 text-[10px] text-red-400/40">Started {formatTimestamp(inc.started_at)}</p>
                  </div>
                ))}
              </div>
            )}

            {resolvedIncidents.length > 0 && (
              <div className="space-y-2">
                {resolvedIncidents.map((inc) => (
                  <div key={inc.id} className="rounded-2xl border border-white/[0.04] bg-white/[0.02] px-5 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="inline-block h-2 w-2 rounded-full bg-[#00a884]/50" />
                        <span className="text-sm font-medium text-white/60">{DISPLAY_NAMES[inc.check_name] || inc.check_name}</span>
                      </div>
                      <span className="shrink-0 text-[10px] text-white/30">Resolved — {durationString(inc.started_at, inc.resolved_at)}</span>
                    </div>
                    {inc.message && <p className="mt-1 text-xs text-white/40">{inc.message}</p>}
                    {inc.resolution_summary && (
                      <p className="mt-1.5 text-xs text-white/50 border-l-2 border-[#00a884]/30 pl-2.5">
                        {inc.resolution_summary}
                      </p>
                    )}
                    <p className="mt-1 text-[10px] text-white/25">
                      {formatTimestamp(inc.started_at)} → {formatTimestamp(inc.resolved_at!)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <p className="mt-10 text-center text-[11px] text-white/25">
          Checks run every 5 minutes. Data retained for 7 days.
        </p>
      </div>

      {/* Timeline tooltip */}
      {tooltip && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-lg border border-white/10 bg-[#0d1926] px-3 py-2 shadow-xl"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <p className="text-[11px] font-medium text-white/90">{tooltip.date}</p>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${
              tooltip.status === 'Operational' ? 'bg-[#00a884]'
                : tooltip.status === 'Degraded' ? 'bg-yellow-400'
                  : tooltip.status === 'Down' ? 'bg-red-500'
                    : 'bg-white/25'
            }`} />
            <span className="text-[10px] text-white/60">{tooltip.status}</span>
            <span className="text-[10px] text-white/30">· {tooltip.duration}</span>
          </div>
          <div className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-[#0d1926]" />
        </div>
      )}
    </div>
  )
}
