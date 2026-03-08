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
    .select('*, wa_owners(id, display_name, avatar_url)')
    .eq('token', token)
    .eq('active', true)
    .single()
  if (error) return null
  return data
}

export async function createContactAndConversation(
  ownerId: string,
  invitationId: string,
  displayName: string
) {
  const { data: contact, error: contactErr } = await supabase
    .from('wa_contacts')
    .insert({ owner_id: ownerId, invitation_id: invitationId, display_name: displayName })
    .select()
    .single()
  if (contactErr) throw contactErr

  const { data: conversation, error: convErr } = await supabase
    .from('wa_conversations')
    .insert({ owner_id: ownerId, contact_id: contact.id })
    .select()
    .single()
  if (convErr) throw convErr

  return { contact, conversation }
}

export async function getConversation(conversationId: string) {
  const { data, error } = await supabase
    .from('wa_conversations')
    .select('*, wa_owners(display_name, avatar_url), wa_contacts(display_name)')
    .eq('id', conversationId)
    .single()
  if (error) throw error
  return data
}

export async function listMessages(conversationId: string) {
  const { data, error } = await supabase
    .from('wa_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

export async function sendMessage(
  conversationId: string,
  sender: 'contact' | 'avatar',
  type: 'text' | 'voice',
  content: string,
  mediaUrl?: string,
  durationSec?: number
) {
  const { data, error } = await supabase
    .from('wa_messages')
    .insert({
      conversation_id: conversationId,
      sender,
      type,
      content,
      media_url: mediaUrl ?? null,
      duration_sec: durationSec ?? null,
    })
    .select()
    .single()
  if (error) throw error
  return data
}
