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
    .select('*, wa_owners(id, display_name, avatar_url, voice_id, tavus_replica_id)')
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
  const contactId = crypto.randomUUID()
  const conversationId = crypto.randomUUID()
  const contactPayload = {
    id: contactId,
    owner_id: ownerId,
    invitation_id: invitationId,
    display_name: displayName,
  }

  console.log('[createContactAndConversation] inserting contact', contactPayload)

  const { error: contactErr } = await supabase
    .from('wa_contacts')
    .insert(contactPayload)
  if (contactErr) {
    console.log('[createContactAndConversation] contact insert error', {
      message: contactErr.message,
      details: contactErr.details,
      hint: contactErr.hint,
      code: contactErr.code,
      payload: contactPayload,
    })
    throw contactErr
  }

  const conversationPayload = {
    id: conversationId,
    owner_id: ownerId,
    contact_id: contactId,
  }

  console.log('[createContactAndConversation] inserting conversation', conversationPayload)

  const { error: convErr } = await supabase
    .from('wa_conversations')
    .insert(conversationPayload)
  if (convErr) {
    console.log('[createContactAndConversation] conversation insert error', {
      message: convErr.message,
      details: convErr.details,
      hint: convErr.hint,
      code: convErr.code,
      payload: conversationPayload,
    })
    throw convErr
  }

  return {
    contact: contactPayload,
    conversation: conversationPayload,
  }
}

export async function getConversation(conversationId: string) {
  const { data, error } = await supabase
    .from('wa_conversations')
    .select('*, wa_owners(display_name, avatar_url, voice_id, tavus_replica_id), wa_contacts(display_name)')
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
