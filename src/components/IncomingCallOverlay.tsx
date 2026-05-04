import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { type OutboundCallRecord, pollOutboundCall, respondToOutboundCall } from '../lib/api'
import { playNotificationSound, showLocalNotification } from '../lib/notifications'

export default function IncomingCallOverlay() {
  const { user, loading } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [call, setCall] = useState<OutboundCallRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const seenCallRef = useRef<string | null>(null)

  const email = String(user?.email || '').trim().toLowerCase()
  const isOnCallScreen = location.pathname.startsWith('/video-call/')

  useEffect(() => {
    if (loading || !email) return
    let active = true

    const refresh = async () => {
      try {
        const payload = await pollOutboundCall(email)
        if (!active) return
        const nextCall = payload.call
        setCall(nextCall)

        if (nextCall && seenCallRef.current !== nextCall.id) {
          seenCallRef.current = nextCall.id
          if (document.visibilityState === 'visible') {
            playNotificationSound('pulse')
          } else {
            showLocalNotification(
              `${nextCall.caller_display_name || 'Your avatar'} is calling`,
              'Tap to answer the incoming video call.',
              nextCall.conversation_id,
            )
          }
        }
      } catch (error) {
        console.warn('[IncomingCallOverlay] poll failed', error)
      }
    }

    void refresh()
    const timer = window.setInterval(() => {
      void refresh()
    }, 5000)

    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [email, loading])

  const callerName = useMemo(() => call?.caller_display_name || 'Your avatar', [call])

  async function respond(action: 'accept' | 'decline') {
    if (!call || busy) return
    setBusy(true)
    try {
      const payload = await respondToOutboundCall(call.id, action)
      setCall(null)
      if (action === 'accept') {
        const relative = payload.joinUrl.replace(/^https?:\/\/[^/]+/i, '')
        navigate(relative)
      }
    } catch (error) {
      console.error('[IncomingCallOverlay] response failed', error)
    } finally {
      setBusy(false)
    }
  }

  if (!call || isOnCallScreen) return null

  return (
    <div className="pointer-events-none fixed inset-0 z-[120] flex items-end justify-center p-4 sm:items-center">
      <div className="pointer-events-auto w-full max-w-md rounded-[28px] border border-[#78f0de]/20 bg-[linear-gradient(180deg,rgba(11,20,31,0.98),rgba(7,14,22,0.98))] p-5 shadow-[0_25px_80px_rgba(0,0,0,0.45)] backdrop-blur-2xl">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[rgba(66,214,193,0.18)] text-[#9af8ea]">
            <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M17 10.5V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-3.5l4 4v-11l-4 4z" />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.22em] text-[#9af8ea]/70">Incoming Call</p>
            <h2 className="truncate text-xl font-semibold text-white">{callerName}</h2>
            <p className="mt-1 text-sm text-white/62">Wants to talk with you now.</p>
          </div>
        </div>

        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={() => void respond('decline')}
            disabled={busy}
            className="flex-1 rounded-full border border-white/12 bg-white/[0.04] px-5 py-3 text-sm font-medium text-white/78 transition hover:bg-white/[0.08] disabled:opacity-50"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={() => void respond('accept')}
            disabled={busy}
            className="flex-1 rounded-full bg-[linear-gradient(135deg,#56dfc8,#5faeff)] px-5 py-3 text-sm font-semibold text-[#04131d] shadow-[0_10px_30px_rgba(95,174,255,0.28)] transition hover:brightness-105 disabled:opacity-50"
          >
            Answer
          </button>
        </div>
      </div>
    </div>
  )
}
