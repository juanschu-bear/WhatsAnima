import { createClient } from '@supabase/supabase-js'

function getHeader(req: any, name: string) {
  const raw = req.headers?.[name] ?? req.headers?.[name.toLowerCase()]
  if (Array.isArray(raw)) return String(raw[0] || '')
  return String(raw || '')
}

async function requireUser(req: any) {
  const auth = getHeader(req, 'authorization')
  if (!auth.toLowerCase().startsWith('bearer ')) return null
  const token = auth.slice(7).trim()
  const sbUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
  if (!sbUrl || !anonKey || !token) return null
  const supabase = createClient(sbUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user?.id) return null
  return data.user
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const user = await requireUser(req)
  if (!user) return res.status(401).json({ error: 'Unauthorized' })

  const masterKey = process.env.DEEPGRAM_MASTER_KEY || process.env.DEEPGRAM_API_KEY
  const projectId = process.env.DEEPGRAM_PROJECT_ID
  if (!masterKey || !projectId) {
    return res.status(503).json({ error: 'Missing DEEPGRAM_MASTER_KEY or DEEPGRAM_PROJECT_ID' })
  }

  try {
    const response = await fetch(`https://api.deepgram.com/v1/projects/${projectId}/keys`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${masterKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        comment: `WhatsAnima voice v2 ${user.id}`,
        tags: ['whatsanima', 'voice-v2', user.id],
        time_to_live_in_seconds: 1800,
      }),
    })

    const payload = await response.json().catch(() => ({}))
    if (!response.ok || !payload?.key) {
      return res.status(502).json({ error: payload?.err_msg || payload?.message || `Deepgram key creation failed (${response.status})` })
    }

    return res.status(200).json({
      key: payload.key,
      expires_at: Date.now() + 1800 * 1000,
    })
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to issue Deepgram token' })
  }
}
