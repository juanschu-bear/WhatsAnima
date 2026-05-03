import { createPerceptionLog, sendMessage } from '../api'
import { callOpmApi } from '../mediaUtils'
import { draftStore, type VoiceDraft } from './draft-store'

type QueueEvent = 'success' | 'failure'
type QueueHandler = (local_id: string) => void

const BACKOFF_MS = [1000, 5000, 30000, 120000, 600000]
const CHANNEL_NAME = 'whatsanima-voice-upload-queue'
const TAB_ID = crypto.randomUUID()

const handlers: Record<QueueEvent, Set<QueueHandler>> = {
  success: new Set(),
  failure: new Set(),
}

const timers = new Map<string, number>()
const inFlight = new Set<string>()
const remoteClaims = new Map<string, number>()
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null

let started = false

function emit(event: QueueEvent, local_id: string) {
  handlers[event].forEach((handler) => handler(local_id))
}

function dispatchDraftEvent(local_id: string) {
  window.dispatchEvent(new CustomEvent('voice-draft-updated', { detail: { local_id } }))
}

function nextBackoff(attempts: number) {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]
}

function hasRemoteClaim(local_id: string) {
  const expiry = remoteClaims.get(local_id)
  return Boolean(expiry && expiry > Date.now())
}

function claim(local_id: string) {
  const expiry = Date.now() + 15000
  remoteClaims.set(local_id, expiry)
  channel?.postMessage({ type: 'claim', local_id, tabId: TAB_ID, expiry })
}

function release(local_id: string) {
  remoteClaims.delete(local_id)
  channel?.postMessage({ type: 'release', local_id, tabId: TAB_ID })
}

async function patchMessage(messageId: string, updates: Record<string, unknown>) {
  await fetch('/api/send-message', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId, updates }),
  })
}

async function createMessageRow(draft: VoiceDraft): Promise<string> {
  const content = draft.transcript_final || draft.transcript_interim || null
  const message = await sendMessage(
    draft.conversation_id,
    'contact',
    'voice',
    content || '',
    undefined,
    Math.max(1, Math.round(draft.duration_ms / 1000)),
    {
      localId: draft.local_id,
      transcriptInterim: draft.transcript_interim,
      transcriptFinal: draft.transcript_final,
      transcriptStatus: draft.transcript_final ? 'final' : draft.transcript_interim ? 'streaming' : 'pending',
      audioStatus: draft.status === 'upload_failed' ? 'failed' : 'pending',
      audioRetryCount: draft.attempts,
      audioLastError: draft.last_error,
    },
  )
  return String(message.id)
}

async function ensureMessageId(draft: VoiceDraft): Promise<VoiceDraft> {
  if (draft.message_id) return draft
  const messageId = await createMessageRow(draft)
  await draftStore.updateStatus(draft.local_id, { message_id: messageId })
  dispatchDraftEvent(draft.local_id)
  return { ...draft, message_id: messageId }
}

async function uploadDraftAudio(draft: VoiceDraft) {
  const ext = draft.mime_type.includes('mp4') ? 'm4a' : draft.mime_type.includes('ogg') ? 'ogg' : 'webm'
  const path = `${draft.conversation_id}/${draft.local_id}.${ext}`
  const formData = new FormData()
  formData.append('file', draft.audio_blob, `voice-${draft.local_id}.${ext}`)
  formData.append('conversationId', draft.conversation_id)
  formData.append('filename', path)
  formData.append('mimeType', draft.mime_type)
  const response = await fetch('/api/upload-audio', {
    method: 'POST',
    body: formData,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !payload?.url) {
    throw new Error(payload?.error || `Upload failed (${response.status})`)
  }
  return String(payload.url)
}

async function triggerNonBlockingPostUpload(draft: VoiceDraft) {
  if (!draft.message_id || !draft.transcript_final) return
  if (!draft.owner_id || !draft.contact_id) {
    await fetch('/api/avatar-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        conversationId: draft.conversation_id,
        userMessage: draft.transcript_final,
        userMessageId: draft.message_id,
        options: { isVoice: true, useVoice: true, perception: null },
      }),
    }).catch(() => undefined)
    return
  }

  const conversation = {
    id: draft.conversation_id,
    owner_id: draft.owner_id,
    contact_id: draft.contact_id,
    wa_contacts: { display_name: draft.contact_name || null },
    wa_owners: { display_name: draft.owner_name || null },
  }

  const opmResponse = await callOpmApi(conversation, draft.audio_blob, 'audio').catch(() => null)
  if (opmResponse && draft.message_id) {
    await createPerceptionLog({
      messageId: draft.message_id,
      conversationId: draft.conversation_id,
      contactId: draft.contact_id,
      ownerId: draft.owner_id,
      transcript: draft.transcript_final,
      audioDurationSec: Math.max(1, Math.round(draft.duration_ms / 1000)),
      primaryEmotion: opmResponse?.perception?.primary_emotion ?? null,
      secondaryEmotion: opmResponse?.perception?.secondary_emotion ?? null,
      firedRules: opmResponse?.fired_rules ?? null,
      behavioralSummary: opmResponse?.behavioral_summary ?? opmResponse?.perception?.behavioral_summary ?? null,
      conversationHooks: opmResponse?.conversation_hooks ?? null,
      recommendedTone: opmResponse?.recommended_tone ?? opmResponse?.perception?.recommended_tone ?? null,
      prosodicSummary: opmResponse?.prosodic_summary ?? null,
      mediaType: 'audio',
      personaName: draft.owner_name ?? null,
    }).catch(() => undefined)
  }

  await fetch('/api/avatar-reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    keepalive: true,
    body: JSON.stringify({
      conversationId: draft.conversation_id,
      userMessage: draft.transcript_final,
      userMessageId: draft.message_id,
      options: { isVoice: true, useVoice: true, perception: opmResponse },
    }),
  }).catch(() => undefined)
}

async function processDraft(local_id: string) {
  if (inFlight.has(local_id) || hasRemoteClaim(local_id)) return
  inFlight.add(local_id)
  claim(local_id)

  try {
    const current = await draftStore.get(local_id)
    if (!current || current.status === 'uploaded') return

    const draft = await ensureMessageId(current)
    if (!navigator.onLine) {
      if (draft.message_id) {
        await patchMessage(draft.message_id, {
          audio_status: 'pending',
          audio_last_error: 'Recording saved locally. Will retry when connection improves.',
          audio_retry_count: draft.attempts,
        })
      }
      await draftStore.updateStatus(local_id, {
        status: 'pending_upload',
        last_error: 'Recording saved locally. Will retry when connection improves.',
      })
      dispatchDraftEvent(local_id)
      return
    }

    await draftStore.updateStatus(local_id, {
      status: 'uploading',
      attempts: draft.attempts + 1,
      last_error: null,
    })
    if (draft.message_id) {
      await patchMessage(draft.message_id, {
        audio_status: 'uploading',
        audio_retry_count: draft.attempts + 1,
        audio_last_error: null,
        transcript_interim: draft.transcript_interim,
        transcript_final: draft.transcript_final,
        transcript_status: draft.transcript_final ? 'final' : draft.transcript_interim ? 'streaming' : draft.status === 'transcript_failed' ? 'unavailable' : 'pending',
        content: draft.transcript_final || draft.transcript_interim || null,
      })
    }
    dispatchDraftEvent(local_id)

    const audioUrl = await uploadDraftAudio(draft)
    await draftStore.updateStatus(local_id, {
      status: 'uploaded',
      audio_url: audioUrl,
      last_error: null,
    })
    if (draft.message_id) {
      await patchMessage(draft.message_id, {
        media_url: audioUrl,
        audio_status: 'uploaded',
        audio_last_error: null,
        transcript_interim: draft.transcript_interim,
        transcript_final: draft.transcript_final,
        transcript_status: draft.transcript_final ? 'final' : draft.transcript_interim ? 'streaming' : 'unavailable',
        content: draft.transcript_final || draft.transcript_interim || null,
      })
    }
    dispatchDraftEvent(local_id)
    emit('success', local_id)
    void triggerNonBlockingPostUpload({ ...draft, audio_url: audioUrl })
  } catch (error) {
    const draft = await draftStore.get(local_id)
    const message = error instanceof Error ? error.message : 'Upload failed'
    if (draft) {
      await draftStore.updateStatus(local_id, {
        status: 'upload_failed',
        last_error: navigator.onLine ? message : 'Recording saved locally. Will retry when connection improves.',
      })
      if (draft.message_id) {
        await patchMessage(draft.message_id, {
          audio_status: 'failed',
          audio_last_error: navigator.onLine ? message : 'Recording saved locally. Will retry when connection improves.',
          audio_retry_count: draft.attempts + 1,
        })
      }
      dispatchDraftEvent(local_id)
      emit('failure', local_id)
      const delay = nextBackoff(draft.attempts)
      const timer = window.setTimeout(() => {
        timers.delete(local_id)
        void processDraft(local_id)
      }, delay)
      timers.set(local_id, timer)
    }
  } finally {
    inFlight.delete(local_id)
    release(local_id)
  }
}

async function flushPending() {
  const drafts = await draftStore.listAllPending()
  await Promise.all(drafts.map((draft) => processDraft(draft.local_id)))
}

function handleOnline() {
  void flushPending()
}

channel?.addEventListener('message', (event) => {
  const payload = event.data || {}
  if (payload?.tabId === TAB_ID) return
  if (payload?.type === 'claim' && payload?.local_id) {
    remoteClaims.set(String(payload.local_id), Number(payload.expiry) || Date.now() + 15000)
  }
  if (payload?.type === 'release' && payload?.local_id) {
    remoteClaims.delete(String(payload.local_id))
  }
  if (payload?.type === 'enqueue' && payload?.local_id) {
    void processDraft(String(payload.local_id))
  }
})

export const uploadQueue = {
  start() {
    if (started) return
    started = true
    window.addEventListener('online', handleOnline)
    void flushPending()
  },
  stop() {
    if (!started) return
    started = false
    window.removeEventListener('online', handleOnline)
    timers.forEach((timerId) => window.clearTimeout(timerId))
    timers.clear()
  },
  enqueue(local_id: string) {
    this.start()
    channel?.postMessage({ type: 'enqueue', local_id, tabId: TAB_ID })
    void processDraft(local_id)
  },
  async retry(local_id: string) {
    const timerId = timers.get(local_id)
    if (timerId) {
      window.clearTimeout(timerId)
      timers.delete(local_id)
    }
    await processDraft(local_id)
  },
  on(event: QueueEvent, handler: QueueHandler) {
    handlers[event].add(handler)
    return () => {
      handlers[event].delete(handler)
    }
  },
}
