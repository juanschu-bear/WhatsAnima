import { getSupabaseAdmin, normalizeBody } from './_lib/liveSessionAudit.js'

function normalizeAvatarList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item || '').trim()).filter(Boolean)
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
    const inviteCode = String(body.inviteCode || '').trim()
    const userId = String(body.userId || '').trim()
    const userEmail = String(body.userEmail || '').trim().toLowerCase() || null

    if (!inviteCode || !userId) {
      return res.status(400).json({ error: 'inviteCode and userId are required' })
    }

    const { data: invitation, error: invitationError } = await supabase
      .from('wa_invitations')
      .select('*')
      .eq('invite_code', inviteCode)
      .maybeSingle()

    if (invitationError) {
      return res.status(500).json({ error: invitationError.message || 'Failed to read invitation' })
    }

    if (!invitation) {
      return res.status(404).json({ error: 'Invitation not found' })
    }

    if (invitation.status !== 'pending') {
      return res.status(400).json({ error: 'Invitation is no longer pending' })
    }

    if (invitation.expires_at && new Date(invitation.expires_at).getTime() <= Date.now()) {
      await supabase
        .from('wa_invitations')
        .update({ status: 'expired' })
        .eq('id', invitation.id)
      return res.status(400).json({ error: 'Invitation has expired' })
    }

    const allowedAvatars = normalizeAvatarList(invitation.allowed_avatars)
    if (allowedAvatars.length === 0) {
      return res.status(400).json({ error: 'Invitation has no allowed avatars' })
    }

    const { data: owners } = await supabase
      .from('wa_owners')
      .select('id, display_name')
      .in('display_name', allowedAvatars)
      .is('deleted_at', null)

    const ownerByAvatar = new Map<string, string>()
    for (const owner of owners ?? []) {
      const key = String(owner.display_name || '').trim()
      if (key) ownerByAvatar.set(key, String(owner.id || '').trim())
    }

    for (const avatarName of allowedAvatars) {
      const ownerId = ownerByAvatar.get(avatarName) || null
      await supabase
        .from('wa_user_avatar_access')
        .upsert(
          {
            user_id: userId,
            owner_id: ownerId,
            avatar_name: avatarName,
            granted_by: invitation.inviter_id,
            invite_id: invitation.id,
            revoked_at: null,
          },
          { onConflict: 'user_id,avatar_name' },
        )

      await supabase
        .from('wa_user_onboarding')
        .upsert(
          {
            user_id: userId,
            avatar_name: avatarName,
            onboarding_completed: false,
          },
          { onConflict: 'user_id,avatar_name' },
        )
    }

    await supabase
      .from('wa_invitations')
      .update({ status: 'accepted', accepted_at: new Date().toISOString(), invitee_email: userEmail })
      .eq('id', invitation.id)

    return res.status(200).json({
      invitationId: invitation.id,
      inviteeName: invitation.invitee_name,
      language: invitation.language || 'en',
      allowedAvatars,
    })
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to accept invitation' })
  }
}
