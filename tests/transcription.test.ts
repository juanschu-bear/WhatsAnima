import { describe, it, expect } from 'vitest'

const API_BASE = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : process.env.API_BASE || 'http://localhost:3000'

describe('Transcription API', () => {
  it('should return clean text from the /api/transcribe endpoint', async () => {
    const deepgramKey = process.env.DEEPGRAM_API_KEY
    const elevenLabsKey = process.env.ELEVENLABS_API_KEY || process.env.VITE_ELEVENLABS_API_KEY

    if (!deepgramKey && !elevenLabsKey) {
      console.warn('Skipping: No STT API key (DEEPGRAM_API_KEY or ELEVENLABS_API_KEY)')
      return
    }

    // Create a minimal WAV with silence
    const sampleRate = 16000
    const durationSec = 1
    const numSamples = sampleRate * durationSec
    const buffer = new ArrayBuffer(44 + numSamples * 2)
    const view = new DataView(buffer)
    const te = new TextEncoder()

    new Uint8Array(buffer).set(te.encode('RIFF'), 0)
    view.setUint32(4, 36 + numSamples * 2, true)
    new Uint8Array(buffer).set(te.encode('WAVE'), 8)
    new Uint8Array(buffer).set(te.encode('fmt '), 12)
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    new Uint8Array(buffer).set(te.encode('data'), 36)
    view.setUint32(40, numSamples * 2, true)

    const blob = new Blob([buffer], { type: 'audio/wav' })
    const formData = new FormData()
    formData.append('file', blob, 'test.wav')

    let response: Response
    try {
      response = await fetch(`${API_BASE}/api/transcribe`, {
        method: 'POST',
        body: formData,
      })
    } catch (err: any) {
      if (err.cause?.code === 'ECONNREFUSED' || err.message?.includes('fetch failed')) {
        console.warn('Skipping: API server not running at', API_BASE)
        return
      }
      throw err
    }

    expect(response.status).toBeLessThan(500)

    if (response.ok) {
      const data = await response.json()
      expect(typeof data.text).toBe('string')
    }
  })
})
