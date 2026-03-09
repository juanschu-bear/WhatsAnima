import { supabase } from './supabase'

export type MessageType = 'text' | 'voice' | 'video' | 'image'

export async function getOwnerByUserId(userId: string) {
  const { data, error } = await supabase
    .from('wa_owners')
    .select('*')
    .eq('user_id', userId)
    .single()
  if (error) throw error
  return data
}

export async function createOwnerIfNeeded(payload: {
  userId: string
  firstName: string
  lastName: string
  phoneNumber: string
}) {
  const displayName = `${payload.firstName} ${payload.lastName}`.trim()
  const { data: existing } = await supabase
    .from('wa_owners')
    .select('*')
    .eq('user_id', payload.userId)
    .single()

  if (existing) {
    const { data, error } = await supabase
      .from('wa_owners')
      .update({
        display_name: displayName || existing.display_name,
        first_name: payload.firstName || existing.first_name,
        last_name: payload.lastName || existing.last_name,
        phone_number: payload.phoneNumber || existing.phone_number,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select()
      .single()
    if (error) throw error
    return data
  }

  const { data, error } = await supabase
    .from('wa_owners')
    .insert({
      user_id: payload.userId,
      display_name: displayName || payload.phoneNumber,
      first_name: payload.firstName,
      last_name: payload.lastName,
      phone_number: payload.phoneNumber,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function generateInvitationLink(ownerId: string, label?: string) {
  const { data, error } = await supabase
    .from('wa_invitation_links')
    .insert({ owner_id: ownerId, label: label || null, active: true })
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
    .select('*')
    .eq('token', token)
    .eq('active', true)
    .single()
  if (error) return null

  const { data: owner } = await supabase
    .from('wa_owners')
    .select('id, display_name, avatar_url, voice_id, tavus_replica_id, system_prompt')
    .eq('id', data.owner_id)
    .maybeSingle()

  return {
    ...data,
    wa_owners: owner ?? {
      id: data.owner_id,
      display_name: 'WhatsAnima',
      avatar_url: null,
      voice_id: null,
      tavus_replica_id: null,
      system_prompt: null,
    },
  }
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
    .select('*, wa_owners(display_name, avatar_url, voice_id, tavus_replica_id, system_prompt), wa_contacts(display_name)')
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

export async function listPerceptionLogs(conversationId: string) {
  const { data, error } = await supabase
    .from('wa_perception_logs')
    .select('message_id, transcript, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function createPerceptionLog(payload: {
  messageId: string
  conversationId: string
  contactId: string
  ownerId: string
  transcript?: string | null
  audioDurationSec?: number | null
}) {
  const { data, error } = await supabase
    .from('wa_perception_logs')
    .insert({
      message_id: payload.messageId,
      conversation_id: payload.conversationId,
      contact_id: payload.contactId,
      owner_id: payload.ownerId,
      transcript: payload.transcript ?? null,
      audio_duration_sec: payload.audioDurationSec ?? null,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function sendMessage(
  conversationId: string,
  sender: 'contact' | 'avatar',
  type: MessageType,
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
