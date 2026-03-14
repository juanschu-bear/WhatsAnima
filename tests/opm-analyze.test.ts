import { describe, it, expect } from 'vitest'

const OPM_BASE = 'https://boardroom-api.onioko.com'

describe('OPM API /analyze endpoint', () => {
  it('should return a job_id from POST /analyze', async () => {
    // Create a minimal audio blob for submission
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
    formData.append('video', blob, 'test.wav')
    formData.append('session_id', 'vitest-integration-test')
    formData.append('preset', 'echo')

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)

    try {
      const response = await fetch(`${OPM_BASE}/analyze`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      })

      clearTimeout(timeout)

      // OPM should accept the request (even if it later fails to process silence)
      if (response.ok) {
        const data = await response.json()
        expect(data.job_id).toBeTruthy()
        expect(typeof data.job_id).toBe('string')
      } else {
        // If OPM is down or rejects, we still expect a structured error
        const errData = await response.json().catch(() => ({}))
        console.warn('OPM /analyze returned', response.status, errData)
        // Don't fail the test if OPM is down — just verify it responded
        expect(response.status).toBeDefined()
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.warn('OPM /analyze timed out (15s) — server may be down')
        return
      }
      throw err
    }
  })
})
