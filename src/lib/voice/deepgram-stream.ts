export interface DeepgramStream {
  send(chunk: Blob | ArrayBuffer): void
  close(): Promise<void>
  onInterim: (text: string) => void
  onFinal: (text: string) => void
  onError: (err: Error) => void
}

type DeepgramEncoding = 'opus' | 'webm-opus' | 'mp4a'

function buildUrl(opts: {
  language?: string
  encoding?: DeepgramEncoding
  sampleRate?: number
}) {
  const params = new URLSearchParams({
    model: 'nova-3',
    language: opts.language || 'multi',
    smart_format: 'true',
    interim_results: 'true',
    vad_events: 'true',
    endpointing: '300',
  })
  if (opts.encoding) params.set('encoding', opts.encoding)
  if (opts.sampleRate) params.set('sample_rate', String(opts.sampleRate))
  return `wss://api.deepgram.com/v1/listen?${params.toString()}`
}

function extractTranscript(payload: any): string {
  return String(payload?.channel?.alternatives?.[0]?.transcript || payload?.channels?.[0]?.alternatives?.[0]?.transcript || '').trim()
}

export async function openDeepgramStream(opts: {
  apiKey: string
  language?: string
  encoding?: DeepgramEncoding
  sampleRate?: number
}): Promise<DeepgramStream> {
  return await new Promise<DeepgramStream>((resolve, reject) => {
    const authScheme = opts.apiKey.includes('.') ? 'bearer' : 'token'
    const socket = new WebSocket(buildUrl(opts), [authScheme, opts.apiKey])
    let settled = false
    let closeResolver: (() => void) | null = null
    let closeRejecter: ((reason?: unknown) => void) | null = null
    let finalSegments: string[] = []
    let closed = false

    const stream: DeepgramStream = {
      onInterim: () => undefined,
      onFinal: () => undefined,
      onError: () => undefined,
      send(chunk) {
        if (socket.readyState !== WebSocket.OPEN) return
        if (chunk instanceof Blob) {
          void chunk.arrayBuffer().then((buffer) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(buffer)
          }).catch((error) => {
            stream.onError(error instanceof Error ? error : new Error('Failed to read audio chunk'))
          })
          return
        }
        socket.send(chunk)
      },
      close() {
        if (closed) return Promise.resolve()
        closed = true
        return new Promise<void>((resolveClose, rejectClose) => {
          closeResolver = resolveClose
          closeRejecter = rejectClose
          try {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'CloseStream' }))
              window.setTimeout(() => {
                if (socket.readyState === WebSocket.OPEN) socket.close()
              }, 1200)
            } else {
              resolveClose()
            }
          } catch (error) {
            rejectClose(error)
          }
        })
      },
    }

    socket.onopen = () => {
      settled = true
      resolve(stream)
    }

    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data || '{}'))
        const transcript = extractTranscript(payload)
        if (!transcript) return
        if (payload?.is_final) {
          finalSegments = [...finalSegments, transcript]
          stream.onFinal(finalSegments.join(' ').trim())
          return
        }
        const prefix = finalSegments.join(' ').trim()
        const combined = [prefix, transcript].filter(Boolean).join(' ').trim()
        stream.onInterim(combined)
      } catch (error) {
        stream.onError(error instanceof Error ? error : new Error('Deepgram message parsing failed'))
      }
    }

    socket.onerror = () => {
      const error = new Error('Deepgram stream failed')
      if (!settled) {
        settled = true
        reject(error)
      }
      stream.onError(error)
      closeRejecter?.(error)
    }

    socket.onclose = () => {
      closeResolver?.()
    }
  })
}
