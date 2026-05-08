import { getSupabaseAdmin, normalizeBody } from './_lib/liveSessionAudit.js'

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

function generateInviteCode(inviteeName: string) {
  const base = slugify(inviteeName)
  const suffix = Math.random().toString(36).slice(2, 8)
  return base ? `${base}-${suffix}` : suffix
}

function buildOrigin(req: any) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
  const host = forwardedHost || String(req.headers.host || '').trim()
  const proto = forwardedProto || (host.includes('localhost') ? 'http' : 'https')
  return host ? `${proto}://${host}` : 'https://www.whatsanima.com'
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { client: supabase, missing } = getSupabaseAdmin()
  if (!supabase) {
    return res.status(503).json({ error: `DB not configured – missing ${missing}` })
  }

  try {
    const body = normalizeBody(req)
    const inviterId = String(body.inviterId || '').trim()
    const inviteeName = String(body.inviteeName || '').trim()
    const inviteeEmail = String(body.inviteeEmail || '').trim().toLowerCase() || null
    const language = String(body.language || 'en').trim().toLowerCase() || 'en'
    const allowedAvatarsRaw = Array.isArray(body.allowedAvatars) ? body.allowedAvatars : []
    const allowedAvatars = allowedAvatarsRaw
      .map((value) => String(value || '').trim())
      .filter(Boolean)

    if (!inviterId || !inviteeName || allowedAvatars.length === 0) {
      return res.status(400).json({
        error: 'inviterId, inviteeName and at least one allowed avatar are required',
      })
    }

    let inviteCode = generateInviteCode(inviteeName)
    for (let attempts = 0; attempts < 5; attempts += 1) {
      const { data: existing } = await supabase
        .from('wa_invitations')
        .select('id')
        .eq('invite_code', inviteCode)
        .maybeSingle()
      if (!existing) break
      inviteCode = generateInviteCode(`${inviteeName}-${attempts + 1}`)
    }

    const payload = {
      invite_code: inviteCode,
      inviter_id: inviterId,
      invitee_name: inviteeName,
      invitee_email: inviteeEmail,
      allowed_avatars: allowedAvatars,
      language,
      status: 'pending',
    }

    const { data, error } = await supabase
      .from('wa_invitations')
      .insert(payload)
      .select('*')
      .single()

    if (error) {
      return res.status(500).json({ error: error.message || 'Failed to create invitation' })
    }

    const inviteUrl = `${buildOrigin(req)}/invite/${data.invite_code}`
    return res.status(200).json({ invitation: data, inviteUrl })
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to create invitation' })
  }
}
