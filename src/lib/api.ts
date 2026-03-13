import { supabase } from './supabase'

export type MessageType = 'text' | 'voice' | 'video' | 'image' | 'flashcard' | 'quiz' | 'lesson' | 'fillin'

export interface ContactConversationPayload {
  ownerId: string
  invitationId: string
  firstName: string
  lastName: string
  email: string
}

export interface ConversationListItem {
  id: string
  owner_id: string
  contact_id: string
  created_at: string
  updated_at: string
  message_count: number
  wa_contacts: {
    id: string
    display_name: string | null
    email: string | null
  } | null
  last_message: {
    id: string
    content: string | null
    type: MessageType
    created_at: string
    sender: 'contact' | 'avatar'
  } | null
}

export interface OwnerDashboardStats {
  totalContacts: number
  totalConversations: number
  totalMessages: number
}

interface ConversationRow {
  id: string
  owner_id: string
  contact_id: string
  created_at: string
  updated_at: string
  wa_contacts:
    | Array<{
        id: string
        display_name: string | null
        email: string | null
      }>
    | null
}

export async function listAllOwners() {
  const { data, error } = await supabase
    .from('wa_owners')
    .select('id, display_name, voice_id, system_prompt, tavus_replica_id')
    .order('display_name', { ascending: true })
  if (error) throw error
  return data ?? []
}

export async function findOrCreateConversation(ownerId: string, contactId: string) {
  const { data: existing } = await supabase
    .from('wa_conversations')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('contact_id', contactId)
    .maybeSingle()
  if (existing) return existing.id

  const id = crypto.randomUUID()
  const { error } = await supabase
    .from('wa_conversations')
    .insert({ id, owner_id: ownerId, contact_id: contactId })
  if (error) throw error
  return id
}

export async function findContactByEmail(email: string) {
  const { data } = await supabase
    .from('wa_contacts')
    .select('id, owner_id, display_name, email')
    .eq('email', email)
    .limit(1)
    .maybeSingle()
  return data
}

export async function getOwnerByUserId(userId: string) {
  const { data, error } = await supabase
    .from('wa_owners')
    .select('*')
    .eq('user_id', userId)
    .limit(1)
  if (error) throw error
  if (!data || data.length === 0) throw new Error('Owner not found')
  return data[0]
}

export async function updateOwnerProfile(ownerId: string, fields: { display_name?: string; avatar_url?: string | null; settings?: Record<string, unknown> }) {
  const { error } = await supabase
    .from('wa_owners')
    .update(fields)
    .eq('id', ownerId)
  if (error) throw error
}

export async function uploadOwnerAvatar(ownerId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop() ?? 'jpg'
  const path = `${ownerId}.${ext}`
  const { error: uploadError } = await supabase.storage
    .from('avatars')
    .upload(path, file, { upsert: true, contentType: file.type })
  if (uploadError) throw uploadError
  const { data } = supabase.storage.from('avatars').getPublicUrl(path)
  return data.publicUrl
}

export async function deleteOwnerAvatar(ownerId: string): Promise<void> {
  // Try common extensions
  for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'gif']) {
    await supabase.storage.from('avatars').remove([`${ownerId}.${ext}`])
  }
}

export async function createOwnerIfNeeded(payload: {
  userId: string
  email: string
  displayName?: string
}) {
  // 1. Try matching by auth user_id (primary key link)
  const { data: byUserId } = await supabase
    .from('wa_owners')
    .select('*')
    .eq('user_id', payload.userId)
    .limit(1)

  if (byUserId && byUserId.length > 0) return byUserId[0]

  // 2. Fallback: try matching by email
  if (payload.email) {
    const { data: byEmail } = await supabase
      .from('wa_owners')
      .select('*')
      .eq('email', payload.email)
      .limit(1)

    if (byEmail && byEmail.length > 0) return byEmail[0]
  }

  // 3. Fallback: if exactly one owner exists, use it (single-owner setup)
  const { data: allOwners } = await supabase
    .from('wa_owners')
    .select('*')
    .limit(10)

  if (allOwners && allOwners.length === 1) {
    return allOwners[0]
  }

  // 4. No existing owner — create a new one
  const { data, error } = await supabase
    .from('wa_owners')
    .insert({
      user_id: payload.userId,
      display_name: payload.displayName || payload.email,
      email: payload.email,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function generateInvitationLink(ownerId: string, label?: string) {
  const { error } = await supabase
    .from('wa_invitation_links')
    .insert({ owner_id: ownerId, label: label || null, active: true })

  if (error) throw error

  const { data: created, error: readError } = await supabase
    .from('wa_invitation_links')
    .select('*')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (readError) throw readError
  return created
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

export async function deleteInvitationLink(linkId: string) {
  const { error } = await supabase
    .from('wa_invitation_links')
    .delete()
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
    .select('id, display_name, voice_id, tavus_replica_id, system_prompt')
    .eq('id', data.owner_id)
    .maybeSingle()

  return {
    ...data,
    wa_owners: owner ?? {
      id: data.owner_id,
      display_name: 'Avatar',
      voice_id: null,
      tavus_replica_id: null,
      system_prompt: null,
    },
  }
}

export async function createContactAndConversation(payload: ContactConversationPayload) {
  const contactId = crypto.randomUUID()
  const conversationId = crypto.randomUUID()
  const firstName = payload.firstName.trim()
  const lastName = payload.lastName.trim()
  const email = payload.email.trim()
  const displayName = [firstName, lastName].filter(Boolean).join(' ').trim() || email
  const contactPayload = {
    id: contactId,
    owner_id: payload.ownerId,
    invitation_id: payload.invitationId,
    display_name: displayName,
    email,
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
    owner_id: payload.ownerId,
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

  const { data: inviteLink, error: inviteReadErr } = await supabase
    .from('wa_invitation_links')
    .select('id, use_count')
    .eq('id', payload.invitationId)
    .maybeSingle()
  if (inviteReadErr) {
    console.log('[createContactAndConversation] invite read error', {
      message: inviteReadErr.message,
      details: inviteReadErr.details,
      hint: inviteReadErr.hint,
      code: inviteReadErr.code,
      invitationId: payload.invitationId,
    })
  } else if (inviteLink) {
    const nextUseCount = Number(inviteLink.use_count ?? 0) + 1
    const { error: inviteUpdateErr } = await supabase
      .from('wa_invitation_links')
      .update({ use_count: nextUseCount })
      .eq('id', payload.invitationId)
    if (inviteUpdateErr) {
      console.log('[createContactAndConversation] invite usage update error', {
        message: inviteUpdateErr.message,
        details: inviteUpdateErr.details,
        hint: inviteUpdateErr.hint,
        code: inviteUpdateErr.code,
        invitationId: payload.invitationId,
        nextUseCount,
      })
    }
  }

  return {
    contact: contactPayload,
    conversation: conversationPayload,
  }
}

export async function listConversations(ownerId: string): Promise<ConversationListItem[]> {
  const { data: conversations, error: conversationsError } = await supabase
    .from('wa_conversations')
    .select(`
      id,
      owner_id,
      contact_id,
      created_at,
      updated_at,
      wa_contacts (
        id,
        display_name,
        email
      )
    `)
    .eq('owner_id', ownerId)
    .order('updated_at', { ascending: false })

  if (conversationsError) throw conversationsError

  const rows = (conversations ?? []) as ConversationRow[]
  if (rows.length === 0) return []

  const conversationIds = rows.map((row) => row.id)
  const { data: messages, error: messagesError } = await supabase
    .from('wa_messages')
    .select('id, conversation_id, content, type, created_at, sender')
    .in('conversation_id', conversationIds)
    .order('created_at', { ascending: false })

  if (messagesError) throw messagesError

  const lastMessageByConversation = new Map<string, ConversationListItem['last_message']>()
  const messageCountByConversation = new Map<string, number>()
  for (const message of messages ?? []) {
    messageCountByConversation.set(
      message.conversation_id,
      (messageCountByConversation.get(message.conversation_id) ?? 0) + 1
    )
    if (!lastMessageByConversation.has(message.conversation_id)) {
      lastMessageByConversation.set(message.conversation_id, {
        id: message.id,
        content: message.content,
        type: message.type as MessageType,
        created_at: message.created_at,
        sender: message.sender as 'contact' | 'avatar',
      })
    }
  }

  return rows.map((row) => ({
    ...row,
    message_count: messageCountByConversation.get(row.id) ?? 0,
    wa_contacts: Array.isArray(row.wa_contacts) ? row.wa_contacts[0] ?? null : row.wa_contacts,
    last_message: lastMessageByConversation.get(row.id) ?? null,
  }))
}

export async function getOwnerDashboardStats(ownerId: string): Promise<OwnerDashboardStats> {
  const [{ count: contactCount, error: contactError }, { count: conversationCount, error: conversationError }] =
    await Promise.all([
      supabase
        .from('wa_contacts')
        .select('id', { count: 'exact', head: true })
        .eq('owner_id', ownerId),
      supabase
        .from('wa_conversations')
        .select('id', { count: 'exact', head: true })
        .eq('owner_id', ownerId),
    ])

  if (contactError) throw contactError
  if (conversationError) throw conversationError

  const { data: conversationIds, error: conversationIdsError } = await supabase
    .from('wa_conversations')
    .select('id')
    .eq('owner_id', ownerId)

  if (conversationIdsError) throw conversationIdsError

  const ids = (conversationIds ?? []).map((conversation) => conversation.id)
  if (ids.length === 0) {
    return {
      totalContacts: contactCount ?? 0,
      totalConversations: conversationCount ?? 0,
      totalMessages: 0,
    }
  }

  const { count: messageCount, error: messageError } = await supabase
    .from('wa_messages')
    .select('id', { count: 'exact', head: true })
    .in('conversation_id', ids)

  if (messageError) throw messageError

  return {
    totalContacts: contactCount ?? 0,
    totalConversations: conversationCount ?? 0,
    totalMessages: messageCount ?? 0,
  }
}

export async function getConversation(conversationId: string) {
  const { data: conversation, error } = await supabase
    .from('wa_conversations')
    .select('*')
    .eq('id', conversationId)
    .single()
  if (error) throw error

  const [{ data: owner }, { data: contact }] = await Promise.all([
    supabase
      .from('wa_owners')
      .select('id, display_name, voice_id, tavus_replica_id, system_prompt')
      .eq('id', conversation.owner_id)
      .maybeSingle(),
    supabase
      .from('wa_contacts')
      .select('id, display_name, email')
      .eq('id', conversation.contact_id)
      .maybeSingle(),
  ])

  return {
    ...conversation,
    wa_owners: owner ?? {
      id: conversation.owner_id,
      display_name: 'Avatar',
      voice_id: null,
      tavus_replica_id: null,
      system_prompt: null,
    },
    wa_contacts: contact ?? {
      id: conversation.contact_id,
      display_name: 'Guest',
      email: null,
    },
  }
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
  if (error) {
    console.warn('[listPerceptionLogs] RLS/query error:', error.message)
    return []
  }
  return data ?? []
}

export async function createPerceptionLog(payload: {
  messageId: string
  conversationId: string
  contactId: string
  ownerId: string
  transcript?: string | null
  audioDurationSec?: number | null
  primaryEmotion?: string | null
  secondaryEmotion?: string | null
  firedRules?: any[] | null
  behavioralSummary?: string | null
  conversationHooks?: any[] | null
  prosodicSummary?: Record<string, any> | null
  mediaType?: 'audio' | 'video' | null
}) {
  const response = await fetch('/api/create-perception-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messageId: payload.messageId,
      conversationId: payload.conversationId,
      contactId: payload.contactId,
      ownerId: payload.ownerId,
      transcript: payload.transcript ?? null,
      audioDurationSec: payload.audioDurationSec ?? null,
      primaryEmotion: payload.primaryEmotion ?? null,
      secondaryEmotion: payload.secondaryEmotion ?? null,
      firedRules: payload.firedRules ?? null,
      behavioralSummary: payload.behavioralSummary ?? null,
      conversationHooks: payload.conversationHooks ?? null,
      prosodicSummary: payload.prosodicSummary ?? null,
      mediaType: payload.mediaType ?? null,
    }),
  })

  const data = await response.json()
  if (!response.ok) {
    throw new Error(data?.error || `createPerceptionLog failed (${response.status})`)
  }
  return data
}

export async function createContactForOwner(payload: {
  ownerId: string
  firstName: string
  lastName: string
  email: string
}) {
  const displayName = [payload.firstName.trim(), payload.lastName.trim()].filter(Boolean).join(' ').trim() || payload.email.trim()

  // Check if contact already exists for this owner+email
  const { data: existing } = await supabase
    .from('wa_contacts')
    .select('id, owner_id, display_name, email')
    .eq('owner_id', payload.ownerId)
    .eq('email', payload.email.trim())
    .maybeSingle()

  if (existing) return existing

  const contactId = crypto.randomUUID()
  const { error } = await supabase
    .from('wa_contacts')
    .insert({
      id: contactId,
      owner_id: payload.ownerId,
      display_name: displayName,
      email: payload.email.trim(),
    })
  if (error) throw error

  return { id: contactId, owner_id: payload.ownerId, display_name: displayName, email: payload.email.trim() }
}

export async function sendMessage(
  conversationId: string,
  sender: 'contact' | 'avatar',
  type: MessageType,
  content: string,
  mediaUrl?: string,
  durationSec?: number
) {
  const response = await fetch('/api/send-message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId,
      sender,
      type,
      content,
      mediaUrl: mediaUrl ?? null,
      durationSec: durationSec ?? null,
    }),
  })

  const data = await response.json()
  if (!response.ok) {
    throw new Error(data?.error || `sendMessage failed (${response.status})`)
  }
  return data
}
