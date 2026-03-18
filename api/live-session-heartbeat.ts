const LIVE_CALL_API_BASE =
  process.env.LIVE_CALL_API_BASE ||
  process.env.VITE_LIVE_CALL_API_BASE ||
  'https://anima.onioko.com'

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const sessionId = String(body.sessionId || '').trim()
  const backendBaseUrl = String(body.backendBaseUrl || LIVE_CALL_API_BASE).trim()

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' })
  }

  const normalizedBase = backendBaseUrl.replace(/\/+$/, '')
  const heartbeatUrl = `${normalizedBase}/api/sessions/${encodeURIComponent(sessionId)}/heartbeat`

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
