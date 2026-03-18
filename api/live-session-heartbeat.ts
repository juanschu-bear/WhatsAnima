const LIVE_CALL_API_BASE =
  process.env.LIVE_CALL_API_BASE ||
  process.env.VITE_LIVE_CALL_API_BASE ||
  'https://anima.onioko.com'

function normalizeBackendBaseUrl(value: string) {
  return value.replace(/\/+$/, '').replace(/\/api$/, '')
}

function normalizeBody(req: any) {
  if (!req || typeof req !== 'object') return {}
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body)
    } catch {
      return {}
    }
  }
  return {}
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const body = normalizeBody(req)
  const sessionId = String(body.sessionId || '').trim()
  const backendBaseUrl = normalizeBackendBaseUrl(String(body.backendBaseUrl || LIVE_CALL_API_BASE).trim())

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' })
  }

  const heartbeatUrl = `${backendBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/heartbeat`

  try {
    const response = await fetch(heartbeatUrl, { method: 'POST' })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return res.status(response.status).json({
        error: `Heartbeat failed (${response.status})`,
        detail,
      })
    }
    return res.status(200).json({ ok: true, sessionId })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown heartbeat error'
    return res.status(502).json({ error: 'Heartbeat request failed', detail: message })
  }
}
