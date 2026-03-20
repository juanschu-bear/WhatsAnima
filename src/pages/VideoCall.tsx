import DailyIframe from '@daily-co/daily-js'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { resolveAvatarUrl } from '../lib/avatars'
import { getConversation } from '../lib/api'

type ConversationData = Awaited<ReturnType<typeof getConversation>>
type CallPhase = 'setup' | 'starting' | 'joining' | 'connected' | 'error'
type SupportedLanguage = 'en' | 'de' | 'es'
type ViewMode = 'speaker' | 'side-by-side'
interface BackendPersona {
  id: string
  key?: string
  name: string
  role?: string
  is_active?: boolean
}

const LIVE_CALL_API_BASE =
  (import.meta.env.VITE_LIVE_CALL_API_BASE as string | undefined) || 'https://anima.onioko.com'
const FALLBACK_REPLICA_ID = 'r987f6e6f73c'
const HEARTBEAT_INTERVAL_MS = 15_000
const ENABLE_LIVE_SESSION_HEARTBEAT = false
const UNLIMITED_DURATION_EMAILS = new Set(['aicallyu.global@gmail.com'])
const FALLBACK_PERSONAS: BackendPersona[] = [
  { id: 'aria', name: 'ARIA', role: 'Executive Coach' },
  { id: 'marcus', name: 'MARCUS', role: 'Technical Interviewer' },
  { id: 'victoria', name: 'VICTORIA', role: 'Venture Capital Partner' },
  { id: 'dr_chen', name: 'DR_CHEN', role: 'Clinical Psychologist' },
  { id: 'elena', name: 'ELENA', role: 'Creative Director' },
  { id: 'maxim', name: 'MAXIM', role: 'Sales Strategist' },
  { id: 'konstantin', name: 'KONSTANTIN', role: 'Geopolitical Analyst' },
  { id: 'dante', name: 'DANTE', role: 'Philosopher & Ethics Advisor' },
]

const LANGUAGES: Array<{ code: SupportedLanguage; label: string; accent: string }> = [
  { code: 'en', label: 'English', accent: 'from-cyan-400/70 to-sky-500/80' },
  { code: 'de', label: 'Deutsch', accent: 'from-emerald-400/70 to-teal-500/80' },
  { code: 'es', label: 'Español', accent: 'from-amber-400/75 to-orange-500/80' },
]

function normalizeLanguageCode(value: string | null | undefined): SupportedLanguage {
  const candidate = (value || '').trim().toLowerCase()
  if (candidate.startsWith('de')) return 'de'
  if (candidate.startsWith('es')) return 'es'
  return 'en'
}

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

function resolveConversationId(
  paramConversationId: string | undefined,
  conversation: ConversationData | null,
): string {
  const byParam = (paramConversationId || '').trim()
  if (byParam) return byParam

  const byConversation = String((conversation as { id?: string } | null)?.id || '').trim()
  if (byConversation) return byConversation

  if (typeof window !== 'undefined') {
    const match = window.location.pathname.match(/\/video-call\/([^/?#]+)/i)
    if (match?.[1]) return decodeURIComponent(match[1]).trim()
  }

  return ''
}

function getParticipantTrack(participant: any, kind: 'video' | 'audio') {
  const source = participant?.tracks?.[kind]
  const candidate = source?.track || source?.persistentTrack
  return candidate instanceof MediaStreamTrack ? candidate : null
}

function buildParticipantStream(participant: any, includeAudio: boolean) {
  const stream = new MediaStream()
  const videoTrack = getParticipantTrack(participant, 'video')
  const audioTrack = getParticipantTrack(participant, 'audio')

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

function getParticipantName(participant: any) {
  return [
    participant?.user_name,
    participant?.user_name?.trim?.(),
    participant?.userData?.name,
    participant?.info?.name,
    participant?.name,
    participant?.session_id,
  ]
    .find((value) => typeof value === 'string' && value.trim().length > 0) ?? ''
}

function isPipecatParticipant(participant: any) {
  const name = getParticipantName(participant).toLowerCase()
  return name.includes('pipecat') || name.includes('bot')
}

function pickAvatarParticipant(participants: any[]) {
  const visibleRemotes = participants.filter((participant) => !participant?.local && !isPipecatParticipant(participant))
  return visibleRemotes.find((participant) => getParticipantTrack(participant, 'video')) ?? visibleRemotes[0] ?? null
}

export default function VideoCall() {
  const navigate = useNavigate()
  const { conversationId } = useParams<{ conversationId: string }>()
  const [searchParams] = useSearchParams()
  const { user } = useAuth()

  const [conversation, setConversation] = useState<ConversationData | null>(null)
  const [loadingConversation, setLoadingConversation] = useState(true)
  const [personas, setPersonas] = useState<BackendPersona[]>(FALLBACK_PERSONAS)
  const [loadingPersonas, setLoadingPersonas] = useState(true)
  const [language, setLanguage] = useState<SupportedLanguage>('en')
  const [selectedPersona, setSelectedPersona] = useState('MAXIM')
  const [viewMode, setViewMode] = useState<ViewMode>('speaker')
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
  const sessionIdRef = useRef<string | null>(null)
  const languageRef = useRef<SupportedLanguage>('en')
  const endingSessionRef = useRef(false)
  const hiddenTimeoutRef = useRef<number | null>(null)
  const personaOverrideEnabled = searchParams.get('personaOverride') === '1'
  const meetingToken = String(searchParams.get('meeting_token') || '').trim()
  const isMeetingMode = meetingToken.length > 0

  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  useEffect(() => {
    languageRef.current = normalizeLanguageCode(language)
  }, [language])

  async function notifySessionStart(nextSessionId: string, joinUrl: string, personaName: string, replicaId: string) {
    try {
      await fetch('/api/live-session-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: nextSessionId,
          conversationId,
          ownerId: conversation?.owner_id ?? conversation?.wa_owners?.id ?? null,
          personaName,
          replicaId,
          language: normalizeLanguageCode(languageRef.current),
          joinUrl,
          backendBaseUrl: LIVE_CALL_API_BASE,
        }),
      })
    } catch (error) {
      console.error('[VideoCall] failed to audit session start', error)
    }
  }

  function beaconSessionEnd(reason: string) {
    const currentSessionId = sessionIdRef.current
    if (!currentSessionId || endingSessionRef.current) return
    endingSessionRef.current = true
    const payload = JSON.stringify({
      sessionId: currentSessionId,
      conversationId,
      ownerId: conversation?.owner_id ?? conversation?.wa_owners?.id ?? null,
      personaName: personaOverrideEnabled ? selectedPersona : conversation?.wa_owners?.display_name || 'MAXIM',
      replicaId: conversation?.wa_owners?.tavus_replica_id?.trim() || FALLBACK_REPLICA_ID,
      language: normalizeLanguageCode(languageRef.current),
      reason,
    })
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/live-session-end', new Blob([payload], { type: 'application/json' }))
      return
    }
    void fetch('/api/live-session-end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => undefined)
  }

  async function endBackendSession(reason: string) {
    const currentSessionId = sessionIdRef.current
    if (!currentSessionId || endingSessionRef.current) return
    endingSessionRef.current = true
    try {
      await fetch('/api/live-session-end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: currentSessionId,
          conversationId,
          ownerId: conversation?.owner_id ?? conversation?.wa_owners?.id ?? null,
          personaName: personaOverrideEnabled ? selectedPersona : conversation?.wa_owners?.display_name || 'MAXIM',
          replicaId: conversation?.wa_owners?.tavus_replica_id?.trim() || FALLBACK_REPLICA_ID,
          language: normalizeLanguageCode(languageRef.current),
          reason,
        }),
        keepalive: true,
      })
    } catch (error) {
      console.error('[VideoCall] failed to end backend session', error)
    } finally {
      sessionIdRef.current = null
      setSessionId(null)
    }
  }

  useEffect(() => {
    if (isMeetingMode) {
      const raw = sessionStorage.getItem(`wa_meeting_context:${meetingToken}`)
      if (!raw) {
        setError('Meeting context missing. Please rejoin from the meeting link.')
        setLoadingConversation(false)
        return
      }
      try {
        const parsed = JSON.parse(raw) as {
          owner?: {
            id?: string
            display_name?: string | null
            tavus_replica_id?: string | null
          } | null
          self?: { name?: string } | null
        }
        const ownerId = String(parsed.owner?.id || '').trim() || 'meeting-owner'
        const syntheticConversationId = conversationId || `meeting-${meetingToken}`
        setConversation({
          id: syntheticConversationId,
          owner_id: ownerId,
          contact_id: `meeting-${meetingToken}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          wa_owners: {
            id: ownerId,
            display_name: parsed.owner?.display_name || 'Avatar',
            email: null,
            voice_id: null,
            tavus_replica_id: parsed.owner?.tavus_replica_id || null,
            system_prompt: null,
            settings: null,
            bio: null,
            expertise: null,
          },
          wa_contacts: {
            id: `meeting-${meetingToken}`,
            display_name: parsed.self?.name || 'Guest',
            email: null,
          },
        } as ConversationData)
      } catch {
        setError('Meeting context invalid. Please rejoin from the meeting link.')
      } finally {
        setLoadingConversation(false)
      }
      return
    }

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
  }, [conversationId, isMeetingMode, meetingToken])

  useEffect(() => {
    let cancelled = false

    if (!personaOverrideEnabled) {
      setLoadingPersonas(false)
      return () => {
        cancelled = true
      }
    }

    fetch(`${LIVE_CALL_API_BASE}/api/personas`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Persona fetch failed (${response.status})`)
        const payload = await response.json() as { personas?: BackendPersona[] }
        const activePersonas = (payload.personas ?? []).filter((persona) => persona?.is_active !== false)
        if (cancelled || activePersonas.length === 0) return
        setPersonas(activePersonas)
        if (activePersonas.some((persona) => persona.name === selectedPersona)) return
        setSelectedPersona(activePersonas[0].name)
      })
      .catch((loadError) => {
        console.error('[VideoCall] persona list failed', loadError)
        if (cancelled) return
        setPersonas(FALLBACK_PERSONAS)
      })
      .finally(() => {
        if (!cancelled) setLoadingPersonas(false)
      })

    return () => {
      cancelled = true
    }
  }, [personaOverrideEnabled, selectedPersona])

  useEffect(() => {
    if (personaOverrideEnabled) return
    const ownerName = conversation?.wa_owners?.display_name?.trim()
    if (ownerName) setSelectedPersona(ownerName)
  }, [conversation?.wa_owners?.display_name, personaOverrideEnabled])

  useEffect(() => {
    return () => {
      if (hiddenTimeoutRef.current) {
        window.clearTimeout(hiddenTimeoutRef.current)
        hiddenTimeoutRef.current = null
      }
      void endBackendSession('component_unmount')
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

  useEffect(() => {
    const handleBeforeUnload = () => {
      beaconSessionEnd('beforeunload')
    }
    const handleVisibilityChange = () => {
      if (document.hidden) {
        hiddenTimeoutRef.current = window.setTimeout(() => {
          beaconSessionEnd('hidden_timeout')
          const callObject = callObjectRef.current
          if (!callObject) return
          void callObject.leave().catch(() => undefined).finally(() => {
            callObject.destroy()
            callObjectRef.current = null
          })
        }, 60_000)
        return
      }
      if (hiddenTimeoutRef.current) {
        window.clearTimeout(hiddenTimeoutRef.current)
        hiddenTimeoutRef.current = null
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    window.addEventListener('pagehide', handleBeforeUnload)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      window.removeEventListener('pagehide', handleBeforeUnload)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [conversation, conversationId, language, personaOverrideEnabled, selectedPersona])

  useEffect(() => {
    if (!ENABLE_LIVE_SESSION_HEARTBEAT) return
    if (!sessionId || (phase !== 'joining' && phase !== 'connected')) return

    const sendHeartbeat = async () => {
      try {
        await fetch('/api/live-session-heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            backendBaseUrl: LIVE_CALL_API_BASE,
          }),
        })
      } catch (error) {
        console.warn('[VideoCall] heartbeat failed', error)
      }
    }

    void sendHeartbeat()
    const interval = window.setInterval(() => {
      void sendHeartbeat()
    }, HEARTBEAT_INTERVAL_MS)

    return () => {
      window.clearInterval(interval)
    }
  }, [phase, sessionId])

  function syncParticipants(callObject: ReturnType<typeof DailyIframe.createCallObject>, eventName?: string) {
    const participants = Object.values(callObject.participants() || {}) as any[]
    const local = participants.find((participant) => participant?.local) ?? null
    const remote = pickAvatarParticipant(participants)

    setLocalParticipant(local)
    setRemoteParticipant(remote)
    if (remote && getParticipantTrack(remote, 'video')) {
      attachStream(remoteVideoRef.current, buildParticipantStream(remote, true), false)
    }
    setStatusText(remote && getParticipantTrack(remote, 'video') ? 'Connected' : 'Avatar joining...')
    setPhase('connected')
    console.log('[VideoCall] syncParticipants', {
      eventName,
      sessionId,
      local: local ? getParticipantName(local) : null,
      avatar: remote ? getParticipantName(remote) : null,
      participants: participants.map((participant) => ({
        name: getParticipantName(participant),
        local: Boolean(participant?.local),
        hiddenBot: isPipecatParticipant(participant),
        hasVideo: Boolean(getParticipantTrack(participant, 'video')),
        hasAudio: Boolean(getParticipantTrack(participant, 'audio')),
      })),
    })
  }

  async function leaveCall() {
    const callObject = callObjectRef.current
    callObjectRef.current = null

    setStatusText('Ending call...')
    setPhase((current) => (current === 'error' ? current : 'starting'))

    const endSessionPromise = endBackendSession('leave_button')
    const leaveRoomPromise = (async () => {
      if (!callObject) return
      await callObject.leave().catch(() => undefined)
      callObject.destroy()
    })()

    await Promise.allSettled([endSessionPromise, leaveRoomPromise])

    if (isMeetingMode) {
      navigate(`/meeting/${encodeURIComponent(meetingToken)}`, { replace: true })
      return
    }

    if (conversationId) {
      navigate(`/chat/${conversationId}`, { replace: true })
      return
    }

    navigate('/', { replace: true })
  }

  async function startCall() {
    if (!conversation) return
    const resolvedConversationId = resolveConversationId(conversationId, conversation)
    if (!resolvedConversationId) {
      setPhase('error')
      setStatusText('Connection failed')
      setError('Missing conversation ID. Reopen the call from the chat camera icon.')
      return
    }
    const owner = conversation.wa_owners
    const personaName = personaOverrideEnabled ? selectedPersona : owner.display_name || selectedPersona
    const replicaId = owner.tavus_replica_id?.trim() || FALLBACK_REPLICA_ID
    const ownerSettings = (owner as { settings?: Record<string, unknown> | null })?.settings
    const personaIdFromOwner = typeof ownerSettings?.tavus_persona_id === 'string'
      ? ownerSettings.tavus_persona_id.trim()
      : ''
    const ownerEmail = String((owner as { email?: string | null })?.email || '').trim().toLowerCase()
    const ownerDisplayName = String(owner.display_name || '').trim().toLowerCase()
    const enableGlueForExtendedJuan =
      ownerEmail === 'mwg.jmschubert@gmail.com' || ownerDisplayName === 'juan schubert (extended)'

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
      const languageCode = normalizeLanguageCode(languageRef.current)
      const isUnlimitedDurationUser = UNLIMITED_DURATION_EMAILS.has(String(user?.email || '').toLowerCase())
      const requestBody = {
        persona_name: personaName,
        persona: personaName,
        persona_id: personaIdFromOwner || undefined,
        replica_id: replicaId,
        language: languageCode,
        glue_enabled: enableGlueForExtendedJuan,
        ...(isUnlimitedDurationUser ? {} : { max_call_duration: 120 }),
        user_name: buildUserName(user, conversation),
        conversation_id: resolvedConversationId,
        owner_id: owner.id || conversation.owner_id || null,
        contact_name: conversation.wa_contacts?.display_name || null,
        meeting_token: meetingToken || undefined,
      }
      console.log('[VideoCall] startSession request', requestBody)
      const response = await fetch('/api/video-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...requestBody,
          backendBaseUrl: LIVE_CALL_API_BASE,
        }),
      })

      if (!response.ok) {
        throw new Error(`Session start failed (${response.status})`)
      }

      const payload = await response.json() as {
        session_id?: string
        join_url?: string
        status?: string
        persona?: string
        replica_id?: string
      }
      console.log('[VideoCall] startSession response', payload)

      if (!payload.join_url || !payload.session_id) {
        throw new Error('Backend did not return a join URL.')
      }

      setSessionId(payload.session_id)
      sessionIdRef.current = payload.session_id
      endingSessionRef.current = false
      setStatusText('Avatar joining...')
      setPhase('joining')
      await notifySessionStart(payload.session_id, payload.join_url, personaName, replicaId)

      const callObject = DailyIframe.createCallObject()
      callObjectRef.current = callObject

      const logEvent = (eventName: string, event?: any) => {
        console.log(`[VideoCall] ${eventName}`, {
          sessionId: payload.session_id,
          participant: event?.participant
            ? {
                name: getParticipantName(event.participant),
                local: Boolean(event.participant?.local),
                hiddenBot: isPipecatParticipant(event.participant),
                hasVideo: Boolean(getParticipantTrack(event.participant, 'video')),
                hasAudio: Boolean(getParticipantTrack(event.participant, 'audio')),
              }
            : null,
          event,
        })
      }
      const handleParticipantChange = (eventName: string, event?: any) => {
        logEvent(eventName, event)
        syncParticipants(callObject, eventName)
        if (event?.participant && !event.participant?.local && !isPipecatParticipant(event.participant) && getParticipantTrack(event.participant, 'video')) {
          attachStream(remoteVideoRef.current, buildParticipantStream(event.participant, true), false)
        }
      }

      callObject.on('joined-meeting', (event: any) => handleParticipantChange('joined-meeting', event))
      callObject.on('left-meeting', (event: any) => {
        logEvent('left-meeting', event)
        void endBackendSession('left_meeting')
      })
      callObject.on('participant-joined', (event: any) => handleParticipantChange('participant-joined', event))
      callObject.on('participant-updated', (event: any) => handleParticipantChange('participant-updated', event))
      callObject.on('participant-left', (event: any) => {
        handleParticipantChange('participant-left', event)
        if (event?.participant && !event.participant?.local && !isPipecatParticipant(event.participant)) {
          void endBackendSession('participant_left')
        }
      })
      callObject.on('track-started', (event: any) => handleParticipantChange('track-started', event))
      callObject.on('track-stopped', (event: any) => handleParticipantChange('track-stopped', event))
      callObject.on('active-speaker-change', (event: any) => logEvent('active-speaker-change', event))
      callObject.on('camera-error', (event: any) => {
        logEvent('camera-error', event)
        setError('Camera access was blocked. Enable camera permissions and retry.')
        setPhase('error')
      })
      callObject.on('error', (event: any) => {
        logEvent('error', event)
        setError('The live call failed to connect. Retry to create a new session.')
        setPhase('error')
      })

      await callObject.join({ url: payload.join_url })
      await callObject.setLocalAudio(isMicEnabled)
      await callObject.setLocalVideo(isCameraEnabled)
      syncParticipants(callObject, 'post-join')
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
  const personaName = personaOverrideEnabled ? selectedPersona : owner.display_name || selectedPersona
  const replicaId = owner.tavus_replica_id?.trim() || FALLBACK_REPLICA_ID
  const selectedPersonaDetails = personas.find((persona) => persona.name === selectedPersona) ?? null
  const showRemoteVideo = Boolean(remoteParticipant && getParticipantTrack(remoteParticipant, 'video'))
  const showLocalVideo = Boolean(localParticipant && getParticipantTrack(localParticipant, 'video') && isCameraEnabled)
  const selectedLanguage = LANGUAGES.find((item) => item.code === language)

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

          <div className="min-w-[78px] text-right text-[11px] text-white/55">
            {sessionId ? (
              <div>
                <div className="uppercase tracking-[0.18em] text-white/35">Session</div>
                <div className="mt-1 font-medium text-white/70">{sessionId.slice(0, 8)}</div>
              </div>
            ) : null}
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col px-3 pb-[calc(env(safe-area-inset-bottom)+0.875rem)] sm:px-6 sm:pb-[calc(env(safe-area-inset-bottom)+1.25rem)]">
          <div className="relative flex min-h-0 flex-1 overflow-hidden rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(9,18,28,0.94),rgba(4,10,18,0.96))] shadow-[0_40px_120px_rgba(0,0,0,0.45)] sm:rounded-[32px]">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(112,240,222,0.13),transparent_32%)]" />

            <div className="relative flex h-full w-full items-center justify-center">
              <div className="relative h-full w-full">
                <div
                  className={`absolute inset-0 overflow-hidden bg-black/20 transition-all duration-300 ${
                    callReady && viewMode === 'side-by-side' ? 'right-1/2 border-r border-white/10' : 'right-0'
                  }`}
                >
                  {showRemoteVideo ? (
                    <video
                      ref={remoteVideoRef}
                      autoPlay
                      playsInline
                      className="h-full w-full object-cover transition-opacity duration-500"
                    />
                  ) : (
                    <div className="flex h-full w-full max-w-md flex-col items-center justify-center px-6 text-center">
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
                        {phase === 'setup' ? 'Choose a language and start the room.' : statusText}
                      </p>
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-4 py-3 text-sm font-semibold text-white/88">
                    {personaName}
                  </div>
                </div>

                <div
                  className={`absolute overflow-hidden bg-[linear-gradient(180deg,rgba(22,31,45,0.95),rgba(10,16,27,0.98))] transition-all duration-300 ${
                    callReady && viewMode === 'side-by-side'
                      ? 'inset-y-0 right-0 w-1/2 rounded-none border-l border-white/10'
                      : 'bottom-4 left-4 h-32 w-[5.5rem] rounded-[22px] border border-white/12 shadow-[0_18px_60px_rgba(0,0,0,0.35)] sm:bottom-5 sm:left-5 sm:h-44 sm:w-32 sm:rounded-[24px]'
                  }`}
                >
                  {showLocalVideo ? (
                    <video
                      ref={localVideoRef}
                      autoPlay
                      muted
                      playsInline
                      className="h-full w-full object-cover"
                      style={{ transform: 'scaleX(-1)' }}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_45%),linear-gradient(180deg,rgba(14,19,30,0.98),rgba(7,10,18,0.98))] px-3 text-center text-xs text-white/50">
                      Camera off
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/72 to-transparent px-3 py-2 text-[11px] text-white/80">
                    <span>You</span>
                    {callReady && viewMode === 'speaker' ? (
                      <span className={`h-2.5 w-2.5 rounded-full ${isMicEnabled ? 'bg-[#70f0de]' : 'bg-red-400'}`} />
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center px-3 pt-4 sm:px-4 sm:pt-5">
                <div className="rounded-full border border-white/10 bg-black/28 px-3 py-2 text-[11px] font-medium tracking-[0.22em] text-white/78 backdrop-blur-xl sm:px-4 sm:text-xs">
                  {statusText}
                </div>
              </div>

              {phase === 'setup' ? (
                <div className="absolute inset-x-0 bottom-24 flex justify-center px-3 sm:bottom-28 sm:px-4">
                  <div className="w-full max-w-xl rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(6,14,24,0.95),rgba(6,10,18,0.98))] p-4 shadow-[0_28px_90px_rgba(0,0,0,0.45)] backdrop-blur-2xl sm:rounded-[28px] sm:p-5">
                    <p className="text-xs uppercase tracking-[0.26em] text-white/45">
                      {personaOverrideEnabled ? 'Persona override (testing)' : 'Avatar identity'}
                    </p>
                    {personaOverrideEnabled ? (
                      <label className="mt-3 block">
                        <select
                          value={selectedPersona}
                          onChange={(event) => setSelectedPersona(event.target.value)}
                          className="min-h-12 w-full appearance-none rounded-[20px] border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-white outline-none transition focus:border-[#79f5e4]/40"
                          disabled={loadingPersonas}
                        >
                          {personas.map((persona) => (
                            <option key={persona.id || persona.name} value={persona.name} className="bg-[#0b1520] text-white">
                              {persona.name} {persona.role ? `- ${persona.role}` : ''}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <div className="mt-3 rounded-[20px] border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-white/92">
                        {owner.display_name || 'Owner avatar'}
                      </div>
                    )}
                    {personaOverrideEnabled && selectedPersonaDetails?.role ? (
                      <p className="mt-2 text-sm text-white/60">{selectedPersonaDetails.role}</p>
                    ) : null}
                    <p className="mt-4 text-xs uppercase tracking-[0.26em] text-white/45">Session language</p>
                    <div className="mt-4 grid gap-3 sm:grid-cols-3">
                      {LANGUAGES.map((item) => {
                        const active = language === item.code
                        return (
                          <button
                            key={item.code}
                            type="button"
                            onClick={() => {
                              languageRef.current = normalizeLanguageCode(item.code)
                              setLanguage(item.code)
                            }}
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
                      Owner avatar: {owner.display_name || 'Unconfigured'} · Session persona: {personaName} · Language: {selectedLanguage?.label ?? 'English'} · Replica: {replicaId}
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

          <div className="mt-3 flex items-center justify-center gap-2 px-1 sm:mt-4">
            <div className="rounded-full border border-white/10 bg-white/6 p-1">
              <button
                type="button"
                onClick={() => setViewMode('speaker')}
                className={`rounded-full px-3 py-2 text-xs font-medium transition ${viewMode === 'speaker' ? 'bg-white text-[#06101a]' : 'text-white/72 hover:text-white'}`}
              >
                Speaker view
              </button>
              <button
                type="button"
                onClick={() => setViewMode('side-by-side')}
                className={`rounded-full px-3 py-2 text-xs font-medium transition ${viewMode === 'side-by-side' ? 'bg-white text-[#06101a]' : 'text-white/72 hover:text-white'}`}
              >
                Side by side
              </button>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-center gap-3 px-1 sm:mt-4 sm:gap-4">
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
