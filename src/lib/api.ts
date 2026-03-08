import { supabase } from './supabase'

export async function getOwnerByUserId(userId: string) {
  const { data, error } = await supabase
    .from('wa_owners')
    .select('*')
    .eq('user_id', userId)
    .single()
  if (error) throw error
  return data
}

export async function createOwnerIfNeeded(userId: string, displayName: string) {
  const { data: existing } = await supabase
    .from('wa_owners')
    .select('*')
    .eq('user_id', userId)
    .single()
  if (existing) return existing

  const { data, error } = await supabase
    .from('wa_owners')
    .insert({ user_id: userId, display_name: displayName })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function generateInvitationLink(ownerId: string, label?: string) {
  const { data, error } = await supabase
    .from('wa_invitation_links')
    .insert({ owner_id: ownerId, label: label || null })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function listInvitationLinks(ownerId: string) {
  const { data, error } = await supabase
    .from('wa_invitation_links')
    .select('*')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function toggleInvitationLink(linkId: string, active: boolean) {
  const { error } = await supabase
    .from('wa_invitation_links')
    .update({ active })
    .eq('id', linkId)
  if (error) throw error
}

export async function validateInvitationToken(token: string) {
  const { data, error } = await supabase
    .from('wa_invitation_links')
    .select('*, wa_owners(display_name, avatar_url)')
    .eq('token', token)
    .eq('active', true)
    .single()
  if (error) return null
  return data
}
