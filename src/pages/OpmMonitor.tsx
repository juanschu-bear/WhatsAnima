import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

const LIVE_CALL_API_BASE =
  (import.meta.env.VITE_LIVE_CALL_API_BASE as string | undefined) || 'https://anima.onioko.com'
const POLL_MS = 5_000

type OpmPayload = Record<string, unknown> | null

export default function OpmMonitor() {
  const [searchParams] = useSearchParams()
  const sessionId = String(searchParams.get('session') || '').trim()
  const [payload, setPayload] = useState<OpmPayload>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdate, setLastUpdate] = useState<number | null>(null)
  const streamRef = useRef<HTMLDivElement | null>(null)

  const hasData = Boolean(payload && Object.keys(payload).length > 0)

  const prettyJson = useMemo(() => {
    if (!payload) return ''
    return JSON.stringify(payload, null, 2)
  }, [payload])

  useEffect(() => {
    if (!streamRef.current) return
    streamRef.current.scrollTop = streamRef.current.scrollHeight
  }, [prettyJson])

  useEffect(() => {
    if (!sessionId) {
      setError('Missing session query param. Use /opm-monitor?session=SESSION_ID')
      return
    }

    let cancelled = false

    const poll = async () => {
      try {
        const response = await fetch(
          `${LIVE_CALL_API_BASE}/api/tools/opm-raw?session_id=${encodeURIComponent(sessionId)}`,
          { cache: 'no-store' },
        )
        if (!response.ok) {
          throw new Error(`OPM raw fetch failed (${response.status})`)
        }
        const data = await response.json() as Record<string, unknown>
        if (cancelled) return
        setPayload(data)
        setLastUpdate(Date.now())
        setError(null)
      } catch (fetchError) {
        if (cancelled) return
        setError(fetchError instanceof Error ? fetchError.message : 'OPM fetch failed')
      }
    }

    void poll()
    const timer = window.setInterval(() => {
      void poll()
    }, POLL_MS)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [sessionId])

  const cygnus = String(payload?.cygnus || '').trim()
  const oracle = String(payload?.oracle || '').trim()
  const lucid = String(payload?.lucid || '').trim()

  return (
    <div className="min-h-screen bg-[#050a12] px-4 py-5 text-white sm:px-6">
      <div className="mx-auto max-w-6xl">
        <div className="rounded-2xl border border-white/10 bg-[#0b1421] px-4 py-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold tracking-[-0.02em] sm:text-xl">OPM Monitor</h1>
              <p className="mt-1 text-xs text-white/60 sm:text-sm">Session: {sessionId || 'N/A'}</p>
            </div>
            <div className="text-right">
              <div className={`text-xs font-semibold uppercase tracking-[0.18em] ${hasData ? 'text-emerald-300' : 'text-amber-300'}`}>
                {hasData ? 'LIVE OPM' : 'NO DATA'}
              </div>
              <div className="mt-1 text-[11px] text-white/50">
                {lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : 'No updates yet'}
              </div>
            </div>
          </div>
          {error ? (
            <div className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-100">
              {error}
            </div>
          ) : null}
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <div className="rounded-2xl border border-white/10 bg-[#0b1421] p-4">
            <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-white/55">CYGNUS</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-white/85">{cygnus || 'No CYGNUS data.'}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#0b1421] p-4">
            <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-white/55">ORACLE</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-white/85">{oracle || 'No ORACLE data.'}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#0b1421] p-4">
            <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-white/55">LUCID</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-white/85">{lucid || 'No LUCID summary.'}</p>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-white/10 bg-[#0b1421] p-4">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-white/55">Raw OPM JSON</h2>
          <div
            ref={streamRef}
            className="mt-2 h-[52vh] overflow-auto rounded-lg border border-white/10 bg-[#070d16] p-3 font-mono text-xs leading-5 text-cyan-100"
          >
            <pre className="whitespace-pre-wrap break-words">{prettyJson || '{ }'}</pre>
          </div>
        </div>
      </div>
    </div>
  )
}
