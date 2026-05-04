import { draftStore, type VoiceDraft } from './draft-store'
import { openDeepgramStream, type DeepgramStream } from './deepgram-stream'

export interface VoiceRecorderHandle {
  state: 'idle' | 'recording' | 'stopping' | 'stopped' | 'error'
  duration_ms: number
  interim_transcript: string
  final_transcript: string | null
  start(opts: { conversation_id: string; user_id: string; owner_id?: string | null; contact_id?: string | null; owner_name?: string | null; contact_name?: string | null }): Promise<void>
  stop(): Promise<{ local_id: string }>
  cancel(): Promise<void>
}

function shouldSendEncoding(mimeType: string) {
  const lower = mimeType.toLowerCase()
  if (lower.includes('webm') || lower.includes('ogg') || lower.includes('mp4')) return undefined
  if (lower.includes('opus')) return 'opus'
  return undefined
}

function dispatchDraftEvent(local_id: string) {
  window.dispatchEvent(new CustomEvent('voice-draft-updated', { detail: { local_id } }))
}

export function createVoiceRecorder(deps: {
  deepgramApiKey: string
  language?: string
  onStateChange?: (state: VoiceRecorderHandle['state']) => void
  onInterimTranscript?: (text: string) => void
  onFinalTranscript?: (text: string | null) => void
  onError?: (error: Error) => void
}): VoiceRecorderHandle {
  let state: VoiceRecorderHandle['state'] = 'idle'
  let duration_ms = 0
  let interim_transcript = ''
  let final_transcript: string | null = null
  let stream: MediaStream | null = null
  let mediaRecorder: MediaRecorder | null = null
  let deepgram: DeepgramStream | null = null
  let chunks: Blob[] = []
  let startedAt = 0
  let startOpts: Awaited<Parameters<VoiceRecorderHandle['start']>[0]> | null = null

  function setState(next: VoiceRecorderHandle['state']) {
    state = next
    deps.onStateChange?.(next)
  }

  async function teardown() {
    try {
      stream?.getTracks().forEach((track) => track.stop())
    } catch {
      // best effort cleanup
    }
    stream = null
    mediaRecorder = null
    deepgram = null
    chunks = []
  }

  return {
    get state() {
      return state
    },
    get duration_ms() {
      return duration_ms
    },
    get interim_transcript() {
      return interim_transcript
    },
    get final_transcript() {
      return final_transcript
    },
    async start(opts) {
      if (state !== 'idle') return
      startOpts = opts
      duration_ms = 0
      interim_transcript = ''
      final_transcript = null
      chunks = []
      startedAt = Date.now()
      setState('recording')

      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
        const mimeType = mimeCandidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || ''
        mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)

        try {
          deepgram = await openDeepgramStream({
            apiKey: deps.deepgramApiKey,
            language: deps.language,
            encoding: shouldSendEncoding(mediaRecorder.mimeType || 'audio/webm'),
          })
          deepgram.onInterim = (text) => {
            interim_transcript = text
            deps.onInterimTranscript?.(text)
          }
          deepgram.onFinal = (text) => {
            final_transcript = text || final_transcript
            deps.onFinalTranscript?.(final_transcript)
          }
          deepgram.onError = (error) => {
            deps.onError?.(error)
          }
        } catch (error) {
          deps.onError?.(error instanceof Error ? error : new Error('Deepgram stream unavailable'))
          deepgram = null
        }

        mediaRecorder.ondataavailable = (event) => {
          if (!event.data || event.data.size <= 0) return
          chunks.push(event.data)
          deepgram?.send(event.data)
        }

        mediaRecorder.start(250)
      } catch (error) {
        setState('error')
        deps.onError?.(error instanceof Error ? error : new Error('Microphone access required'))
        await teardown()
        setState('idle')
        throw error
      }
    },
    async stop() {
      if (!mediaRecorder || state !== 'recording' || !startOpts) {
        throw new Error('Recorder is not active')
      }

      setState('stopping')

      const recorder = mediaRecorder
      const mimeType = recorder.mimeType || 'audio/webm'
      const blob = await new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          resolve(new Blob(chunks, { type: mimeType }))
        }
        recorder.stop()
      })

      duration_ms = Date.now() - startedAt
      if (duration_ms < 1000) {
        await teardown()
        setState('idle')
        throw new Error('Recording too short to transcribe.')
      }

      const local_id = crypto.randomUUID()
      const draft: VoiceDraft = {
        local_id,
        conversation_id: startOpts.conversation_id,
        user_id: startOpts.user_id,
        audio_blob: blob,
        mime_type: mimeType,
        duration_ms,
        recorded_at: new Date().toISOString(),
        status: 'pending_upload',
        transcript_interim: interim_transcript || null,
        transcript_final: null,
        attempts: 0,
        last_error: null,
        message_id: null,
        owner_id: startOpts.owner_id ?? null,
        contact_id: startOpts.contact_id ?? null,
        owner_name: startOpts.owner_name ?? null,
        contact_name: startOpts.contact_name ?? null,
      }
      await draftStore.save(draft)
      dispatchDraftEvent(local_id)

      void (async () => {
        try {
          await deepgram?.close()
          const finalText = final_transcript?.trim() || interim_transcript.trim() || null
          await draftStore.updateStatus(local_id, {
            transcript_final: finalText,
            transcript_interim: interim_transcript || null,
            status: finalText ? 'pending_upload' : 'transcript_failed',
            last_error: finalText ? null : 'Transcription unavailable right now.',
          })
          dispatchDraftEvent(local_id)
        } catch (error) {
          await draftStore.updateStatus(local_id, {
            status: 'transcript_failed',
            last_error: 'Transcription unavailable right now.',
          })
          dispatchDraftEvent(local_id)
        } finally {
          await teardown()
          setState('stopped')
          window.setTimeout(() => {
            if (state === 'stopped') setState('idle')
          }, 0)
        }
      })()

      return { local_id }
    },
    async cancel() {
      try {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop()
        }
      } catch {
        // ignore
      }
      await teardown()
      interim_transcript = ''
      final_transcript = null
      duration_ms = 0
      setState('idle')
    },
  }
}
