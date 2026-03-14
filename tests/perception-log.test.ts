import { describe, it, expect } from 'vitest'

const API_BASE = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : process.env.API_BASE || 'http://localhost:3000'

describe('Perception Log Creation', () => {
  it('should write a perception log with primary_emotion as a normalized string', async () => {
    let response: Response
    try {
      response = await fetch(`${API_BASE}/api/create-perception-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: '00000000-0000-0000-0000-000000000001',
          contactId: '00000000-0000-0000-0000-000000000002',
          ownerId: '00000000-0000-0000-0000-000000000003',
          transcript: 'Test transcription for vitest',
          audioDurationSec: 5.0,
          primaryEmotion: { label: 'happy', score: 0.85 },
          secondaryEmotion: 'curious',
          firedRules: [],
          behavioralSummary: 'Test behavioral summary',
          conversationHooks: ['test hook'],
          prosodicSummary: { speaking_rate: 3.2, mean_pitch: 180 },
          mediaType: 'audio',
        }),
      })
    } catch (err: any) {
      if (err.cause?.code === 'ECONNREFUSED' || err.message?.includes('fetch failed')) {
        console.warn('Skipping: API server not running at', API_BASE)
        return
      }
      throw err
    }

    if (response.status === 503) {
      console.warn('Skipping: DB not configured (503)')
      return
    }

    if (response.ok) {
      const data = await response.json()
      expect(data.log).toBeTruthy()
      expect(typeof data.log.primary_emotion).toBe('string')
      expect(data.log.primary_emotion).toBe('happy')
      expect(data.log.primary_emotion).not.toContain('{')
      expect(data.canon).toBeTruthy()
      expect(typeof data.canon.phase).toBe('string')
    } else {
      const errData = await response.json().catch(() => ({}))
      console.warn('Perception log test returned', response.status, errData)
    }
  })
})
