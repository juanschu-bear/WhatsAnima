import { describe, it, expect } from 'vitest'

const API_BASE = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : process.env.API_BASE || 'http://localhost:3000'

describe('Chat API — Avatar Response', () => {
  it('should return an avatar response from /api/chat', async () => {
    const anthropicKey = process.env.ANTHROPIC_API_KEY
    if (!anthropicKey) {
      console.warn('Skipping: ANTHROPIC_API_KEY not set')
      return
    }

    let response: Response
    try {
      response = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Hello, this is a test message.',
          history: [],
        }),
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
      expect(data.content).toBeTruthy()
      expect(typeof data.content).toBe('string')
      expect(data.content.length).toBeGreaterThan(0)
      expect(data.content).not.toContain('```generate_image')
    } else {
      const errData = await response.json().catch(() => ({}))
      console.warn('Chat API returned', response.status, errData)
      if (response.status === 500 && errData?.error?.includes('ANTHROPIC_API_KEY')) {
        console.warn('Expected: API key not available in test environment')
        return
      }
    }
  })
})
