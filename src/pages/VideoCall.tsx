import DailyIframe from '@daily-co/daily-js'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { resolveAvatarUrl } from '../lib/avatars'
import { getConversation } from '../lib/api'

type ConversationData = Awaited<ReturnType<typeof getConversation>>
type CallPhase = 'setup' | 'starting' | 'joining' | 'connected' | 'error'
type SupportedLanguage = 'English' | 'Deutsch' | 'Español'

const LIVE_CALL_API_BASE =
  (import.meta.env.VITE_LIVE_CALL_API_BASE as string | undefined) || 'https://anima.onioko.com'
const FALLBACK_REPLICA_ID = 'r987f6e6f73c'

const LANGUAGES: Array<{ label: SupportedLanguage; accent: string }> = [
  { label: 'English', accent: 'from-cyan-400/70 to-sky-500/80' },
  { label: 'Deutsch', accent: 'from-emerald-400/70 to-teal-500/80' },
  { label: 'Español', accent: 'from-amber-400/75 to-orange-500/80' },
]

function buildUserName(user: ReturnType<typeof useAuth>['user'], conversation: ConversationData | null) {
  const fullName = [
    user?.user_metadata?.first_name as string | undefined,
    user?.user_metadata?.last_name as string | undefined,
  ]
    .filter(Boolean)
    .join(' ')
    .trim()

  return (
    fullName ||
    (user?.user_metadata?.full_name as string | undefined) ||
    conversation?.wa_contacts?.display_name ||
    user?.email ||
    'WhatsAnima User'
  )
}

function buildParticipantStream(participant: any, includeAudio: boolean) {
  const stream = new MediaStream()
  const videoTrack = participant?.tracks?.video?.persistentTrack
  const audioTrack = participant?.tracks?.audio?.persistentTrack

  if (videoTrack instanceof MediaStreamTrack) stream.addTrack(videoTrack)
  if (includeAudio && audioTrack instanceof MediaStreamTrack) stream.addTrack(audioTrack)

  return stream.getTracks().length > 0 ? stream : null
}

function attachStream(element: HTMLVideoElement | null, stream: MediaStream | null, muted: boolean) {
  if (!element) return
  element.srcObject = stream
  element.muted = muted
  if (stream) {
    void element.play().catch(() => undefined)
  }
}

export default function VideoCall() {
  const navigate = useNavigate()
  const { conversationId } = useParams<{ conversationId: string }>()
  const { user } = useAuth()

  const [conversation, setConversation] = useState<ConversationData | null>(null)
  const [loadingConversation, setLoadingConversation] = useState(true)
  const [language, setLanguage] = useState<SupportedLanguage>('English')
  const [phase, setPhase] = useState<CallPhase>('setup')
  const [statusText, setStatusText] = useState('Ready to join')
  const [error, setError] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [isMicEnabled, setIsMicEnabled] = useState(true)
  const [isCameraEnabled, setIsCameraEnabled] = useState(true)
  const [localParticipant, setLocalParticipant] = useState<any>(null)
  const [remoteParticipant, setRemoteParticipant] = useState<any>(null)

  const callObjectRef = useRef<ReturnType<typeof DailyIframe.createCallObject> | null>(null)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    if (!conversationId) {
      setError('Missing conversation.')
      setLoadingConversation(false)
      return
    }

    let cancelled = false

    getConversation(conversationId)
      .then((data) => {
        if (cancelled) return
        setConversation(data)
      })
      .catch((loadError) => {
        console.error('[VideoCall] conversation load failed', loadError)
        if (cancelled) return
        setError('Unable to load this conversation.')
        setPhase('error')
      })
      .finally(() => {
        if (!cancelled) setLoadingConversation(false)
      })

    return () => {
      cancelled = true
    }
  }, [conversationId])

  useEffect(() => {
    return () => {
      const callObject = callObjectRef.current
      callObjectRef.current = null
      if (!callObject) return
      void callObject.leave().catch(() => undefined).finally(() => {
        callObject.destroy()
      })
    }
  }, [])

  useEffect(() => {
    const localStream = buildParticipantStream(localParticipant, false)
    attachStream(localVideoRef.current, localStream, true)
  }, [localParticipant])

  useEffect(() => {
    const remoteStream = buildParticipantStream(remoteParticipant, true)
    attachStream(remoteVideoRef.current, remoteStream, false)
  }, [remoteParticipant])

  async function syncParticipants(callObject: ReturnType<typeof DailyIframe.createCallObject>) {
    const participants = Object.values(callObject.participants() || {}) as any[]
    const local = participants.find((participant) => participant?.local) ?? null
    const remote = participants.find((participant) => !participant?.local) ?? null

    setLocalParticipant(local)
    setRemoteParticipant(remote)
    setStatusText(remote ? 'Connected' : 'Avatar joining...')
    setPhase('connected')
  }

  async function leaveCall() {
    const callObject = callObjectRef.current
    callObjectRef.current = null

    if (callObject) {
      await callObject.leave().catch(() => undefined)
      callObject.destroy()
    }

    if (conversationId) {
      navigate(`/chat/${conversationId}`, { replace: true })
      return
    }

    navigate('/', { replace: true })
  }

  async function startCall() {
    if (!conversation || !conversationId) return
    const owner = conversation.wa_owners
    const personaName = owner.display_name?.trim() || 'Avatar'
    const replicaId = owner.tavus_replica_id?.trim() || FALLBACK_REPLICA_ID

    const existingCall = callObjectRef.current
    if (existingCall) {
      await existingCall.leave().catch(() => undefined)
      existingCall.destroy()
      callObjectRef.current = null
    }

    setError(null)
    setSessionId(null)
    setRemoteParticipant(null)
    setLocalParticipant(null)
    setPhase('starting')
    setStatusText('Connecting...')

    try {
      const response = await fetch(`${LIVE_CALL_API_BASE}/api/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          persona_name: personaName,
          replica_id: replicaId,
          language,
          user_name: buildUserName(user, conversation),
        }),
      })

      if (!response.ok) {
        throw new Error(`Session start failed (${response.status})`)
      }

      const payload = await response.json() as {
        session_id?: string
        join_url?: string
        status?: string
      }

      if (!payload.join_url || !payload.session_id) {
        throw new Error('Backend did not return a join URL.')
      }

      setSessionId(payload.session_id)
      setStatusText('Connecting...')
      setPhase('joining')

      const callObject = DailyIframe.createCallObject()
      callObjectRef.current = callObject

      const handleParticipantChange = () => {
        void syncParticipants(callObject)
      }

      callObject.on('joined-meeting', handleParticipantChange)
      callObject.on('participant-joined', handleParticipantChange)
      callObject.on('participant-updated', handleParticipantChange)
      callObject.on('participant-left', handleParticipantChange)
      callObject.on('camera-error', () => {
        setError('Camera access was blocked. Enable camera permissions and retry.')
        setPhase('error')
      })
      callObject.on('error', () => {
        setError('The live call failed to connect. Retry to create a new session.')
        setPhase('error')
      })

      await callObject.join({ url: payload.join_url })
      await callObject.setLocalAudio(isMicEnabled)
      await callObject.setLocalVideo(isCameraEnabled)
      await syncParticipants(callObject)
    } catch (startError) {
      const failedCall = callObjectRef.current
      callObjectRef.current = null
      if (failedCall) {
        await failedCall.leave().catch(() => undefined)
        failedCall.destroy()
      }
      console.error('[VideoCall] start failed', startError)
      setPhase('error')
      setStatusText('Connection failed')
      setError(
        startError instanceof Error
          ? startError.message
          : 'Unable to start the live call right now.',
      )
    }
  }

  async function toggleMic() {
    const next = !isMicEnabled
    setIsMicEnabled(next)
    const callObject = callObjectRef.current
    if (callObject) {
      try {
        callObject.setLocalAudio(next)
      } catch {
        setError('Unable to update microphone state.')
      }
    }
  }

  async function toggleCamera() {
    const next = !isCameraEnabled
    setIsCameraEnabled(next)
    const callObject = callObjectRef.current
    if (callObject) {
      try {
        callObject.setLocalVideo(next)
      } catch {
        setError('Unable to update camera state.')
      }
    }
  }

  if (loadingConversation) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#04080f] text-white">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/10 border-t-[#70f0de]" />
      </div>
    )
  }

  if (!conversation) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#04080f] px-6 text-center text-white">
        <p className="text-lg font-semibold">Conversation not found.</p>
        <button
          type="button"
          onClick={() => navigate('/', { replace: true })}
          className="mt-5 rounded-full border border-white/12 bg-white/6 px-5 py-2.5 text-sm text-white/80 transition hover:bg-white/10"
        >
          Back home
        </button>
      </div>
    )
  }

  const owner = conversation.wa_owners
  const callReady = phase === 'connected'
  const personaName = owner.display_name?.trim() || 'Avatar'
  const replicaId = owner.tavus_replica_id?.trim() || FALLBACK_REPLICA_ID

  return (
    <div className="relative h-[100dvh] min-h-[100dvh] overflow-hidden bg-[radial-gradient(circle_at_top,rgba(0,195,170,0.16),transparent_30%),radial-gradient(circle_at_85%_20%,rgba(53,127,255,0.16),transparent_24%),linear-gradient(180deg,#03060b_0%,#07111a_48%,#02050a_100%)] text-white supports-[-webkit-touch-callout:none]:min-h-[-webkit-fill-available]">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:44px_44px] opacity-30" />

      <div className="relative z-10 flex h-full min-h-0 flex-col">
        <header className="flex items-center justify-between px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6 sm:pb-4">
          <button
            type="button"
            onClick={() => void leaveCall()}
            className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-white/6 text-white/80 transition hover:bg-white/10 hover:text-white"
            aria-label="Back to chat"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>

          <div className="text-center">
            <p className="text-xs uppercase tracking-[0.3em] text-white/45">Live video call</p>
            <h1 className="mt-1 text-base font-semibold tracking-[-0.02em] text-white sm:text-lg">
              {personaName}
            </h1>
          </div>

          <div className="min-w-[52px] text-right text-[11px] text-white/55">
            {sessionId ? <span>#{sessionId.slice(0, 6)}</span> : null}
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col px-3 pb-[calc(env(safe-area-inset-bottom)+0.875rem)] sm:px-6 sm:pb-[calc(env(safe-area-inset-bottom)+1.25rem)]">
          <div className="relative flex min-h-0 flex-1 overflow-hidden rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(9,18,28,0.94),rgba(4,10,18,0.96))] shadow-[0_40px_120px_rgba(0,0,0,0.45)] sm:rounded-[32px]">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(112,240,222,0.13),transparent_32%)]" />

            <div className="relative flex h-full w-full items-center justify-center">
              {callReady && remoteParticipant ? (
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="h-full w-full object-cover transition-opacity duration-500"
                />
              ) : (
                <div className="flex max-w-md flex-col items-center px-6 text-center">
                  <div className="relative">
                    <img
                      src={resolveAvatarUrl(personaName)}
                      alt={personaName}
                      className="h-24 w-24 rounded-full object-cover ring-1 ring-white/10 sm:h-36 sm:w-36"
                    />
                    <span className="absolute -bottom-1 -right-1 h-5 w-5 rounded-full border-4 border-[#08111a] bg-[#70f0de]" />
                  </div>
                  <p className="mt-6 text-2xl font-semibold tracking-[-0.03em] text-white sm:text-3xl">
                    {personaName}
                  </p>
                  <p className="mt-3 text-sm leading-6 text-white/62 sm:text-base">
                    {phase === 'setup'
                      ? 'Choose a language and start the room.'
                      : statusText}
                  </p>
                </div>
              )}

              <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center px-3 pt-4 sm:px-4 sm:pt-5">
                <div className="rounded-full border border-white/10 bg-black/28 px-3 py-2 text-[11px] font-medium tracking-[0.22em] text-white/78 backdrop-blur-xl sm:px-4 sm:text-xs">
                  {statusText}
                </div>
              </div>

              <div className="absolute bottom-4 left-4 h-32 w-[5.5rem] overflow-hidden rounded-[22px] border border-white/12 bg-[linear-gradient(180deg,rgba(22,31,45,0.95),rgba(10,16,27,0.98))] shadow-[0_18px_60px_rgba(0,0,0,0.35)] sm:bottom-5 sm:left-5 sm:h-44 sm:w-32 sm:rounded-[24px]">
                {isCameraEnabled ? (
                  <video
                    ref={localVideoRef}
                    autoPlay
                    muted
                    playsInline
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_45%),linear-gradient(180deg,rgba(14,19,30,0.98),rgba(7,10,18,0.98))] px-3 text-center text-xs text-white/50">
                    Camera off
                  </div>
                )}
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/72 to-transparent px-3 py-2 text-[11px] text-white/80">
                  <span>You</span>
                  <span className={`h-2.5 w-2.5 rounded-full ${isMicEnabled ? 'bg-[#70f0de]' : 'bg-red-400'}`} />
                </div>
              </div>

              {phase === 'setup' ? (
                <div className="absolute inset-x-0 bottom-24 flex justify-center px-3 sm:bottom-28 sm:px-4">
                  <div className="w-full max-w-xl rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(6,14,24,0.95),rgba(6,10,18,0.98))] p-4 shadow-[0_28px_90px_rgba(0,0,0,0.45)] backdrop-blur-2xl sm:rounded-[28px] sm:p-5">
                    <p className="text-xs uppercase tracking-[0.26em] text-white/45">Session language</p>
                    <div className="mt-4 grid gap-3 sm:grid-cols-3">
                      {LANGUAGES.map((item) => {
                        const active = language === item.label
                        return (
                          <button
                            key={item.label}
                            type="button"
                            onClick={() => setLanguage(item.label)}
                            className={`rounded-[20px] border px-4 py-4 text-left transition ${
                              active
                                ? `border-white/20 bg-gradient-to-br ${item.accent} text-[#041018]`
                                : 'border-white/10 bg-white/[0.03] text-white/78 hover:bg-white/[0.06]'
                            }`}
                          >
                            <div className="text-sm font-semibold">{item.label}</div>
                            <div className={`mt-1 text-xs ${active ? 'text-[#08252a]/80' : 'text-white/45'}`}>
                              Join with this language
                            </div>
                          </button>
                        )
                      })}
                    </div>

                    <button
                      type="button"
                      onClick={() => void startCall()}
                      className="mt-5 inline-flex min-h-12 w-full items-center justify-center rounded-[20px] bg-[linear-gradient(135deg,#79f5e4,#48c2ff)] px-5 py-3.5 text-sm font-semibold text-[#041018] shadow-[0_20px_50px_rgba(72,194,255,0.25)] transition hover:brightness-105"
                    >
                      Start live call
                    </button>
                    <p className="mt-3 text-center text-[11px] text-white/42">
                      Persona: {personaName} · Replica: {replicaId}
                    </p>
                  </div>
                </div>
              ) : null}

              {error ? (
                <div className="absolute inset-x-0 bottom-24 flex justify-center px-3 sm:bottom-28 sm:px-4">
                  <div className="w-full max-w-lg rounded-[24px] border border-red-400/20 bg-[linear-gradient(180deg,rgba(39,14,19,0.95),rgba(24,9,13,0.98))] p-4 text-center shadow-[0_28px_80px_rgba(0,0,0,0.38)] sm:p-5">
                    <p className="text-sm font-semibold text-white">Unable to start the call</p>
                    <p className="mt-2 text-sm leading-6 text-white/72">{error}</p>
                    <button
                      type="button"
                      onClick={() => void startCall()}
                      className="mt-4 min-h-11 rounded-full border border-white/12 bg-white/6 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-white/10"
                    >
                      Retry
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="mt-4 flex items-center justify-center gap-3 px-1 sm:mt-5 sm:gap-4">
            <button
              type="button"
              onClick={() => void toggleMic()}
              className={`flex h-14 w-14 touch-manipulation items-center justify-center rounded-full border transition sm:h-[3.75rem] sm:w-[3.75rem] ${
                isMicEnabled
                  ? 'border-white/10 bg-white/6 text-white hover:bg-white/10'
                  : 'border-red-400/20 bg-red-500/12 text-red-200 hover:bg-red-500/18'
              }`}
              aria-label={isMicEnabled ? 'Mute microphone' : 'Unmute microphone'}
            >
              {isMicEnabled ? (
                <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a3 3 0 00-3 3v8a3 3 0 106 0V4a3 3 0 00-3-3zm5 10a5 5 0 01-10 0M12 19v4m-4 0h8" />
                </svg>
              ) : (
                <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 19L5 5m7 14v4m-4 0h8M10.59 10.59V12a1.41 1.41 0 002.82 0V7.41M17 10v2a5 5 0 01-8.36 3.72M7 10v2a5 5 0 008.9 3.1" />
                </svg>
              )}
            </button>

            <button
              type="button"
              onClick={() => void toggleCamera()}
              className={`flex h-14 w-14 touch-manipulation items-center justify-center rounded-full border transition sm:h-[3.75rem] sm:w-[3.75rem] ${
                isCameraEnabled
                  ? 'border-white/10 bg-white/6 text-white hover:bg-white/10'
                  : 'border-red-400/20 bg-red-500/12 text-red-200 hover:bg-red-500/18'
              }`}
              aria-label={isCameraEnabled ? 'Turn camera off' : 'Turn camera on'}
            >
              {isCameraEnabled ? (
                <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M17 10.5V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-3.5l4 4v-11l-4 4z" />
                </svg>
              ) : (
                <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18M10.12 10.12A3 3 0 0015 12V7a2 2 0 00-2-2H6.83m-1.8 0A2 2 0 003 7v10a2 2 0 002 2h10a2 2 0 002-2v-2.17M17 10.5l4-4v11l-4-4" />
                </svg>
              )}
            </button>

            <button
              type="button"
              onClick={() => void leaveCall()}
              className="flex h-14 min-w-[6.5rem] touch-manipulation items-center justify-center rounded-full bg-[linear-gradient(135deg,#ff6a73,#ff3d54)] px-6 text-sm font-semibold text-white shadow-[0_20px_50px_rgba(255,61,84,0.28)] transition hover:brightness-105"
            >
              Leave
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
