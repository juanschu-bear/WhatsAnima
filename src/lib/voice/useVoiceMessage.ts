import { useEffect, useMemo, useRef, useState } from 'react'
import { patchMessage, sendMessage } from '../api'
import { supabase } from '../supabase'
import { createVoiceRecorder } from './recorder'
import { draftStore, type VoiceDraft } from './draft-store'
import { uploadQueue } from './upload-queue'

interface ConversationRef {
  id: string
  owner_id: string
  contact_id: string
  wa_contacts?: { display_name?: string | null } | null
  wa_owners?: { display_name?: string | null } | null
}

interface HookMessage {
  id: string
  sender: 'contact'
  type: 'voice'
  content: string | null
  media_url: string | null
  duration_sec: number | null
  created_at: string
  local_id?: string | null
  transcript_interim?: string | null
  transcript_final?: string | null
  transcript_status?: string | null
  audio_status?: string | null
  audio_retry_count?: number | null
  audio_last_error?: string | null
  _pending?: boolean
  _failed?: boolean
  _errorMessage?: string
  _localBlobUrl?: string | null
  _retryFn?: () => void
  _savedOffline?: boolean
}

export function useVoiceMessage(opts: {
  conversation_id: string
  conversation?: ConversationRef | null
  onMessageSent?: (message: HookMessage) => void
  onMessageUpdate?: (messageId: string, updates: Partial<HookMessage>) => void
  onError?: (error: string | null) => void
  onTranscript?: (messageId: string, transcript: string) => void
}) {
  const [state, setState] = useState<'idle' | 'recording' | 'stopping' | 'sent' | 'failed'>('idle')
  const [duration_ms, setDurationMs] = useState(0)
  const [interim_transcript, setInterimTranscript] = useState('')
  const [final_transcript, setFinalTranscript] = useState<string | null>(null)
  const [pending_drafts, setPendingDrafts] = useState<VoiceDraft[]>([])
  const [sessionUserId, setSessionUserId] = useState<string | null>(null)
  const localUrlsRef = useRef<Map<string, string>>(new Map())
  const recorderRef = useRef<ReturnType<typeof createVoiceRecorder> | null>(null)
  const knownMessagesRef = useRef<Set<string>>(new Set())
  const repliedMessagesRef = useRef<Set<string>>(new Set())

  async function refreshPending() {
    const drafts = await draftStore.listPending(opts.conversation_id)
    setPendingDrafts(drafts.sort((a, b) => a.recorded_at.localeCompare(b.recorded_at)))
  }

  async function fetchDeepgramToken() {
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    const response = await fetch('/api/voice/deepgram-token', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || !payload?.key) {
      throw new Error(payload?.error || 'Unable to open transcription stream.')
    }
    return String(payload.key)
  }

  async function ensureMessageForDraft(draft: VoiceDraft) {
    if (draft.message_id) return draft.message_id
    const message = await sendMessage(
      draft.conversation_id,
      'contact',
      'voice',
      draft.transcript_final || draft.transcript_interim || '',
      undefined,
      Math.max(1, Math.round(draft.duration_ms / 1000)),
      {
        localId: draft.local_id,
        transcriptInterim: draft.transcript_interim,
        transcriptFinal: draft.transcript_final,
        transcriptStatus: draft.transcript_final ? 'final' : draft.transcript_interim ? 'streaming' : draft.status === 'transcript_failed' ? 'unavailable' : 'pending',
        audioStatus: draft.status === 'upload_failed' ? 'failed' : draft.status === 'uploaded' ? 'uploaded' : 'pending',
        audioRetryCount: draft.attempts,
        audioLastError: draft.last_error,
      },
    )
    const messageId = String(message.id)
    await draftStore.updateStatus(draft.local_id, { message_id: messageId })
    return messageId
  }

  async function syncDraftToUi(local_id: string) {
    const draft = await draftStore.get(local_id)
    if (!draft || draft.conversation_id !== opts.conversation_id) return

    const localUrl = localUrlsRef.current.get(local_id) || URL.createObjectURL(draft.audio_blob)
    localUrlsRef.current.set(local_id, localUrl)

    const messageId = await ensureMessageForDraft(draft)
    await patchMessage(messageId, {
      content: draft.transcript_final || draft.transcript_interim || null,
      transcript_interim: draft.transcript_interim,
      transcript_final: draft.transcript_final,
      transcript_status: draft.transcript_final ? 'final' : draft.transcript_interim ? 'streaming' : draft.status === 'transcript_failed' ? 'unavailable' : 'pending',
      audio_status: draft.status === 'uploaded' ? 'uploaded' : draft.status === 'uploading' ? 'uploading' : draft.status === 'upload_failed' ? 'failed' : 'pending',
      audio_retry_count: draft.attempts,
      audio_last_error: draft.last_error,
      media_url: draft.audio_url || null,
    }).catch(() => undefined)
    const updates: Partial<HookMessage> = {
      content: draft.transcript_final || draft.transcript_interim || null,
      media_url: draft.audio_url || null,
      duration_sec: Math.max(1, Math.round(draft.duration_ms / 1000)),
      local_id: draft.local_id,
      transcript_interim: draft.transcript_interim,
      transcript_final: draft.transcript_final,
      transcript_status: draft.transcript_final ? 'final' : draft.transcript_interim ? 'streaming' : draft.status === 'transcript_failed' ? 'unavailable' : 'pending',
      audio_status: draft.status === 'uploaded' ? 'uploaded' : draft.status === 'uploading' ? 'uploading' : draft.status === 'upload_failed' ? 'failed' : 'pending',
      audio_retry_count: draft.attempts,
      audio_last_error: draft.last_error,
      _pending: draft.status === 'pending_upload' || draft.status === 'uploading',
      _failed: draft.status === 'upload_failed' || draft.status === 'transcript_failed',
      _errorMessage: draft.last_error || undefined,
      _localBlobUrl: localUrl,
      _savedOffline: !navigator.onLine && draft.status !== 'uploaded',
      _retryFn: () => {
        void uploadQueue.retry(draft.local_id)
      },
    }

    if (!knownMessagesRef.current.has(messageId)) {
      knownMessagesRef.current.add(messageId)
      opts.onMessageSent?.({
        id: messageId,
        sender: 'contact',
        type: 'voice',
        content: updates.content ?? null,
        media_url: updates.media_url ?? null,
        duration_sec: updates.duration_sec ?? null,
        created_at: draft.recorded_at,
        ...updates,
      })
    } else {
      opts.onMessageUpdate?.(messageId, updates)
    }

    if (draft.transcript_final) {
      opts.onTranscript?.(messageId, draft.transcript_final)
    }

    if (draft.status === 'uploaded' && draft.transcript_final && !repliedMessagesRef.current.has(messageId)) {
      repliedMessagesRef.current.add(messageId)
      void fetch('/api/avatar-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          conversationId: draft.conversation_id,
          userMessage: draft.transcript_final,
          userMessageId: messageId,
          options: { isVoice: true, useVoice: true, perception: null },
        }),
      }).catch(() => {
        repliedMessagesRef.current.delete(messageId)
      })
    }
  }

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => {
      setSessionUserId(data.user?.id ?? null)
    })
  }, [])

  useEffect(() => {
    uploadQueue.start()
    void refreshPending()

    const handleDraft = (event: Event) => {
      const detail = (event as CustomEvent<{ local_id?: string }>).detail
      if (!detail?.local_id) return
      void syncDraftToUi(detail.local_id)
      void refreshPending()
    }

    window.addEventListener('voice-draft-updated', handleDraft as EventListener)
    return () => {
      window.removeEventListener('voice-draft-updated', handleDraft as EventListener)
      localUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      localUrlsRef.current.clear()
    }
  }, [opts.conversation_id])

  useEffect(() => {
    void (async () => {
      const drafts = await draftStore.listPending(opts.conversation_id)
      for (const draft of drafts) {
        await syncDraftToUi(draft.local_id)
        uploadQueue.enqueue(draft.local_id)
      }
      await refreshPending()
    })()
  }, [opts.conversation_id])

  const recorder = useMemo(() => ({
    async get() {
      if (recorderRef.current) return recorderRef.current
      const key = await fetchDeepgramToken()
      const instance = createVoiceRecorder({
        deepgramApiKey: key,
        language: 'multi',
        onStateChange(next) {
          if (next === 'recording' || next === 'stopping') setState(next)
          if (next === 'stopped') setState('sent')
          if (next === 'error') setState('failed')
        },
        onInterimTranscript(text) {
          setInterimTranscript(text)
        },
        onFinalTranscript(text) {
          setFinalTranscript(text)
        },
        onError(error) {
          opts.onError?.(error.message)
        },
      })
      recorderRef.current = instance
      return instance
    },
  }), [opts.conversation_id])

  return {
    state,
    duration_ms,
    interim_transcript,
    final_transcript,
    pending_drafts,
    start_recording: async () => {
      if (!sessionUserId) {
        opts.onError?.('You need to be signed in to record voice notes.')
        return
      }
      const voiceRecorder = await recorder.get()
      setDurationMs(0)
      setInterimTranscript('')
      setFinalTranscript(null)
      opts.onError?.(null)
      await voiceRecorder.start({
        conversation_id: opts.conversation_id,
        user_id: sessionUserId,
        owner_id: opts.conversation?.owner_id ?? null,
        contact_id: opts.conversation?.contact_id ?? null,
        owner_name: opts.conversation?.wa_owners?.display_name ?? null,
        contact_name: opts.conversation?.wa_contacts?.display_name ?? null,
      })
      const startedAt = Date.now()
      const timer = window.setInterval(() => {
        setDurationMs(Date.now() - startedAt)
      }, 100)
      ;(voiceRecorder as any).__timer = timer
    },
    stop_recording: async () => {
      const voiceRecorder = await recorder.get()
      const timer = (voiceRecorder as any).__timer as number | undefined
      if (timer) window.clearInterval(timer)
      try {
        setState('stopping')
        const { local_id } = await voiceRecorder.stop()
        await syncDraftToUi(local_id)
        uploadQueue.enqueue(local_id)
        await refreshPending()
      } catch (error) {
        setState('failed')
        opts.onError?.(error instanceof Error ? error.message : 'Voice recording failed.')
      } finally {
        setDurationMs(0)
      }
    },
    cancel_recording: async () => {
      const voiceRecorder = await recorder.get()
      const timer = (voiceRecorder as any).__timer as number | undefined
      if (timer) window.clearInterval(timer)
      await voiceRecorder.cancel()
      setDurationMs(0)
      setInterimTranscript('')
      setFinalTranscript(null)
      setState('idle')
    },
    retry_draft: async (local_id: string) => {
      await uploadQueue.retry(local_id)
      await refreshPending()
    },
  }
}
