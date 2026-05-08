import { supabase } from './supabase'
import { getCanonicalAppUrl } from './canonicalOrigin'

export type MessageType = 'text' | 'voice' | 'video' | 'image' | 'document' | 'flashcard' | 'quiz' | 'lesson' | 'fillin' | 'call_summary' | 'system'

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

export interface OutboundCallRecord {
  id: string
  conversation_id: string
  owner_id: string | null
  contact_id: string | null
  contact_email: string
  requested_by_message_id: string | null
  trigger_text: string
  mode: 'video'
  status: string
  caller_display_name: string | null
  requested_at: string
  scheduled_for: string
  triggered_at: string | null
  accepted_at: string | null
  declined_at: string | null
  expires_at: string | null
  last_error: string | null
  metadata?: Record<string, unknown> | null
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
  try {
    const response = await fetch('/api/list-owners')
    const data = await response.json()
    if (!response.ok) {
      throw new Error(data?.error || `Failed to load owners (${response.status})`)
    }
    return data ?? []
  } catch (error) {
    console.warn('[listAllOwners] API route failed, falling back to client query:', error)
    const { data, error: queryError } = await supabase
      .from('wa_owners')
      .select('id, display_name, avatar_url')
      .is('deleted_at', null)
      .order('display_name', { ascending: true })

    if (queryError) {
      throw queryError
    }
    return data ?? []
  }
}

export interface OwnerListItem {
  id: string
  display_name: string
  avatar_url: string | null
  provider: 'keyframe' | 'tavus'
}

export interface InvitationRecord {
  id: string
  invite_code: string
  inviter_id: string
  invitee_name: string
  invitee_email: string | null
  allowed_avatars: string[]
  language: string
  status: 'pending' | 'accepted' | 'expired' | 'revoked'
  created_at: string
  accepted_at: string | null
  expires_at: string
}

type ListOwnersForUserArgs =
  | string
  | {
      email?: string | null
      userId?: string | null
    }

// Returns only owners available to the signed-in user.
// Primary source: wa_user_avatar_access (invited access control).
// Legacy fallback: wa_contacts linkage by email.
export async function listOwnersForUser(input: ListOwnersForUserArgs): Promise<OwnerListItem[]> {
  function isKeyframeDisplayName(value: unknown): boolean {
    const normalized = String(value || '').trim().toLowerCase()
    return normalized.includes('trace flores') || normalized.includes('jordan cash')
  }

  function resolveProvider(row: { settings?: unknown; tavus_replica_id?: unknown; display_name?: unknown }): 'keyframe' | 'tavus' {
    if (isKeyframeDisplayName(row.display_name)) return 'keyframe'
    const settings = row.settings && typeof row.settings === 'object' ? row.settings as Record<string, unknown> : null
    const personaSlug = typeof settings?.persona_slug === 'string' ? settings.persona_slug.trim() : ''
    if (personaSlug) return 'keyframe'
    const tavusReplica = String(row.tavus_replica_id || '').trim()
    if (tavusReplica) return 'tavus'
    return 'tavus'
  }

  function normalizeOwners(rows: any[] | null | undefined): OwnerListItem[] {
    return (rows || []).map((row) => ({
      id: String(row.id || '').trim(),
      display_name: String(row.display_name || '').trim(),
      avatar_url: row.avatar_url ? String(row.avatar_url) : null,
      provider: resolveProvider(row),
    })).filter((row) => row.id && row.display_name) as OwnerListItem[]
  }

  const email = (typeof input === 'string' ? input : input.email || '').trim()
  const userId = (typeof input === 'string' ? '' : input.userId || '').trim()

  if (userId) {
    const { data: accessRows, error: accessError } = await supabase
      .from('wa_user_avatar_access')
      .select('owner_id, avatar_name')
      .eq('user_id', userId)
      .is('revoked_at', null)

    if (accessError) throw accessError

    const ownerIds = Array.from(
      new Set((accessRows ?? []).map((row) => String(row.owner_id || '').trim()).filter(Boolean)),
    )
    const avatarNames = Array.from(
      new Set((accessRows ?? []).map((row) => String(row.avatar_name || '').trim()).filter(Boolean)),
    )

    if (ownerIds.length > 0) {
      const { data, error } = await supabase
        .from('wa_owners')
        .select('id, display_name, avatar_url, settings, tavus_replica_id')
        .in('id', ownerIds)
        .is('deleted_at', null)
        .order('display_name', { ascending: true })
      if (error) throw error
      return normalizeOwners(data)
    }

    if (avatarNames.length > 0) {
      const { data, error } = await supabase
        .from('wa_owners')
        .select('id, display_name, avatar_url, settings, tavus_replica_id')
        .in('display_name', avatarNames)
        .is('deleted_at', null)
        .order('display_name', { ascending: true })
      if (error) throw error
      return normalizeOwners(data)
    }
  }

  if (!email) return []
  const normalizedEmail = email.toLowerCase()
  const { data: contacts, error: contactsError } = await supabase
    .from('wa_contacts')
    .select('owner_id')
    .eq('email', normalizedEmail)
  if (contactsError) throw contactsError

  const ownerIds = Array.from(
    new Set((contacts ?? []).map((row) => row.owner_id).filter(Boolean) as string[]),
  )
  if (ownerIds.length === 0) return []

  const { data, error } = await supabase
    .from('wa_owners')
    .select('id, display_name, avatar_url, settings, tavus_replica_id')
    .in('id', ownerIds)
    .is('deleted_at', null)
    .order('display_name', { ascending: true })
  if (error) throw error
  return normalizeOwners(data)
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

export async function findContactByEmailForOwner(ownerId: string, email: string) {
  const normalizedOwnerId = ownerId.trim()
  const normalizedEmail = email.trim()
  if (!normalizedOwnerId || !normalizedEmail) return null

  const { data } = await supabase
    .from('wa_contacts')
    .select('id, owner_id, display_name, email')
    .eq('owner_id', normalizedOwnerId)
    .eq('email', normalizedEmail)
    .limit(1)
    .maybeSingle()
  return data
}

export async function findLatestConversationForOwnerAndEmail(ownerId: string, email: string) {
  const normalizedOwnerId = ownerId.trim()
  const normalizedEmail = email.trim()
  if (!normalizedOwnerId || !normalizedEmail) return null

  const { data: contacts, error: contactsError } = await supabase
    .from('wa_contacts')
    .select('id')
    .eq('email', normalizedEmail)
    .limit(200)

  if (contactsError) throw contactsError
  const contactIds = (contacts ?? []).map((row) => row.id).filter(Boolean)
  if (contactIds.length === 0) return null

  const { data: conversations, error: conversationError } = await supabase
    .from('wa_conversations')
    .select('id, updated_at')
    .eq('owner_id', normalizedOwnerId)
    .in('contact_id', contactIds)
    .order('updated_at', { ascending: false })
    .limit(50)

  if (conversationError) throw conversationError
  if (!conversations || conversations.length === 0) return null

  const conversationIds = conversations.map((row) => row.id)
  const { data: messages, error: messagesError } = await supabase
    .from('wa_messages')
    .select('conversation_id, created_at')
    .in('conversation_id', conversationIds)
    .order('created_at', { ascending: false })
    .limit(500)

  if (messagesError) throw messagesError
  const withHistory = new Set((messages ?? []).map((row) => row.conversation_id))
  const bestMatch = conversations.find((row) => withHistory.has(row.id)) ?? conversations[0]
  return bestMatch?.id ?? null
}

export async function getOwnerByUserId(userId: string) {
  const { data, error } = await supabase
    .from('wa_owners')
    .select('*')
    .eq('user_id', userId)
    .is('deleted_at', null)
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
    .is('deleted_at', null)
  if (error) throw error
}

export async function uploadOwnerAvatar(ownerId: string, file: File): Promise<string> {
  const rawExt = file.name.split('.').pop()?.toLowerCase() ?? 'jpg'
  const ext = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(rawExt) ? rawExt : 'jpg'
  const path = `${ownerId}.${ext}`

  // Delete any previous avatar with a different extension first
  const oldExts = ['jpg', 'jpeg', 'png', 'webp', 'gif'].filter(e => e !== ext)
  await supabase.storage.from('avatars').remove(oldExts.map(e => `${ownerId}.${e}`))

  const { error: uploadError } = await supabase.storage
    .from('avatars')
    .upload(path, file, { upsert: true, contentType: file.type })
  if (uploadError) {
    console.error('[uploadOwnerAvatar] Storage error:', uploadError.message, uploadError)
    throw new Error(`Upload failed: ${uploadError.message}`)
  }
  const { data } = supabase.storage.from('avatars').getPublicUrl(path)
  return data.publicUrl
}

export async function deleteOwnerAvatar(ownerId: string): Promise<void> {
  // Try common extensions
  for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'gif']) {
    await supabase.storage.from('avatars').remove([`${ownerId}.${ext}`])
  }
}

export async function softDeleteOwner(ownerId: string): Promise<void> {
  const { error } = await supabase
    .from('wa_owners')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', ownerId)
  if (error) throw error
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
    .is('deleted_at', null)
    .limit(1)

  if (byUserId && byUserId.length > 0) return byUserId[0]

  // 2. Fallback: try matching by email
  if (payload.email) {
    const { data: byEmail } = await supabase
      .from('wa_owners')
      .select('*')
      .eq('email', payload.email)
      .is('deleted_at', null)
      .limit(1)

    if (byEmail && byEmail.length > 0) return byEmail[0]
  }

  // 3. Fallback: if exactly one owner exists, use it (single-owner setup)
  const { data: allOwners } = await supabase
    .from('wa_owners')
    .select('*')
    .is('deleted_at', null)
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

function generateSlugToken(label: string | null | undefined): string {
  if (label && label.trim()) {
    const slug = label.trim()
      .toLowerCase()
      .replace(/[^a-z0-9äöüß]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
    if (slug.length >= 3) {
      const suffix = Math.random().toString(36).slice(2, 6)
      return `${slug}-${suffix}`
    }
  }
  return crypto.randomUUID().slice(0, 12)
}

export async function generateInvitationLink(ownerId: string, label?: string) {
  const token = generateSlugToken(label)
  const { error } = await supabase
    .from('wa_invitation_links')
    .insert({ owner_id: ownerId, label: label || null, token, active: true })

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
    .is('deleted_at', null)
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

export async function getOnboardingInvitation(inviteCode: string): Promise<InvitationRecord | null> {
  const normalizedCode = inviteCode.trim()
  if (!normalizedCode) return null

  const { data, error } = await supabase
    .from('wa_invitations')
    .select('*')
    .eq('invite_code', normalizedCode)
    .maybeSingle()

  if (error || !data) return null

  const allowed = Array.isArray(data.allowed_avatars)
    ? data.allowed_avatars.map((entry: unknown) => String(entry || '').trim()).filter(Boolean)
    : []

  return {
    ...(data as Omit<InvitationRecord, 'allowed_avatars'>),
    allowed_avatars: allowed,
  } as InvitationRecord
}

export async function createOnboardingInvitation(payload: {
  inviterId: string
  inviteeName: string
  inviteeEmail?: string | null
  allowedAvatars: string[]
  language?: string
}) {
  const response = await fetch('/api/create-invitation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data?.error || `create-invitation failed (${response.status})`)
  }
  return data as {
    invitation: InvitationRecord
    inviteUrl: string
  }
}

export async function acceptOnboardingInvitation(payload: {
  inviteCode: string
  userId: string
  userEmail?: string | null
}) {
  const response = await fetch('/api/accept-invitation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data?.error || `accept-invitation failed (${response.status})`)
  }
  return data as {
    invitationId: string
    inviteeName: string
    language: string
    allowedAvatars: string[]
  }
}

// --- Invitation Bundles (multi-avatar) ---

export interface InvitationBundle {
  id: string
  token: string
  owner_ids: string[]
  label: string | null
  max_uses: number | null
  use_count: number
  active: boolean
  created_by: string | null
  created_at: string
}

export async function generateInvitationBundle(ownerIds: string[], label: string | null, createdBy: string): Promise<InvitationBundle> {
  const token = generateSlugToken(label)
  const { data, error } = await supabase
    .from('wa_invitation_bundles')
    .insert({ owner_ids: ownerIds, label: label || null, token, created_by: createdBy, active: true })
    .select()
    .single()
  if (error) throw error
  return data as InvitationBundle
}

export async function listInvitationBundles(createdBy: string): Promise<InvitationBundle[]> {
  const { data, error } = await supabase
    .from('wa_invitation_bundles')
    .select('*')
    .eq('created_by', createdBy)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as InvitationBundle[]
}

export async function toggleInvitationBundle(bundleId: string, active: boolean) {
  const { error } = await supabase
    .from('wa_invitation_bundles')
    .update({ active })
    .eq('id', bundleId)
  if (error) throw error
}

export async function deleteInvitationBundle(bundleId: string) {
  const { error } = await supabase
    .from('wa_invitation_bundles')
    .delete()
    .eq('id', bundleId)
  if (error) throw error
}

export async function validateBundleToken(token: string): Promise<{ bundle: InvitationBundle; owners: Array<{ id: string; display_name: string }> } | null> {
  const { data, error } = await supabase
    .from('wa_invitation_bundles')
    .select('*')
    .eq('token', token)
    .eq('active', true)
    .single()
  if (error || !data) return null
  const bundle = data as InvitationBundle
  const { data: owners } = await supabase
    .from('wa_owners')
    .select('id, display_name')
    .in('id', bundle.owner_ids)
    .is('deleted_at', null)
  return { bundle, owners: (owners ?? []) as Array<{ id: string; display_name: string }> }
}

export interface BundleConversationPayload {
  bundleId: string
  ownerIds: string[]
  firstName: string
  lastName: string
  email: string
}

export async function createContactAndConversationsFromBundle(payload: BundleConversationPayload) {
  const firstName = payload.firstName.trim()
  const lastName = payload.lastName.trim()
  const email = payload.email.trim()
  const displayName = [firstName, lastName].filter(Boolean).join(' ').trim() || email

  // Create one contact per owner (wa_contacts has owner_id FK)
  const conversations: Array<{ id: string; owner_id: string }> = []
  for (const ownerId of payload.ownerIds) {
    // Duplicate-check: skip if contact with same email+owner already exists
    const { data: existing } = await supabase
      .from('wa_contacts')
      .select('id')
      .eq('owner_id', ownerId)
      .eq('email', email)
      .maybeSingle()
    if (existing) {
      console.warn('[bundle] contact already exists for owner', ownerId, '— skipping')
      continue
    }

    const contactId = crypto.randomUUID()
    const conversationId = crypto.randomUUID()

    const { error: contactErr } = await supabase
      .from('wa_contacts')
      .insert({ id: contactId, owner_id: ownerId, display_name: displayName, email })
    if (contactErr) {
      console.error('[bundle] contact insert error for owner', ownerId, contactErr.message)
      continue
    }

    const { error: convErr } = await supabase
      .from('wa_conversations')
      .insert({ id: conversationId, owner_id: ownerId, contact_id: contactId })
    if (convErr) {
      console.error('[bundle] conversation insert error for owner', ownerId, convErr.message)
      continue
    }

    conversations.push({ id: conversationId, owner_id: ownerId })
  }

  if (conversations.length === 0) {
    throw new Error(`[bundle] all owner inserts failed for bundle ${payload.bundleId}`)
  }

  // Increment use_count
  const { data: bundle } = await supabase
    .from('wa_invitation_bundles')
    .select('use_count')
    .eq('id', payload.bundleId)
    .single()
  if (bundle) {
    await supabase
      .from('wa_invitation_bundles')
      .update({ use_count: (bundle.use_count ?? 0) + 1 })
      .eq('id', payload.bundleId)
  }

  return { conversations }
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
      .select('id, display_name, email, avatar_url, voice_id, tavus_replica_id, system_prompt, settings, bio, expertise')
      .eq('id', conversation.owner_id)
      .is('deleted_at', null)
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
      email: null,
      avatar_url: null,
      voice_id: null,
      tavus_replica_id: null,
      system_prompt: null,
      settings: null,
      bio: null,
      expertise: null,
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
  recommendedTone?: string | null
  prosodicSummary?: Record<string, any> | null
  facialAnalysis?: Record<string, any> | null
  bodyLanguage?: Record<string, any> | null
  mediaType?: 'audio' | 'video' | null
  videoDurationSec?: number | null
  personaName?: string | null
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
      recommendedTone: payload.recommendedTone ?? null,
      prosodicSummary: payload.prosodicSummary ?? null,
      facialAnalysis: payload.facialAnalysis ?? null,
      bodyLanguage: payload.bodyLanguage ?? null,
      mediaType: payload.mediaType ?? null,
      videoDurationSec: payload.videoDurationSec ?? null,
      personaName: payload.personaName ?? null,
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

// --- Usage Limits ---

export interface UsageCheckResult {
  allowed: boolean
  used: number
  limit: number
  remaining: number
  error?: string
  reset_at?: string
}

export async function checkUsage(userId: string | null, feature: 'voice' | 'video' | 'call'): Promise<UsageCheckResult> {
  if (!userId) {
    const { data } = await supabase.auth.getUser()
    userId = data.user?.id ?? null
  }
  if (!userId) return { allowed: true, used: 0, limit: 999, remaining: 999 } // no user = fail open
  const response = await fetch('/api/check-usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, feature }),
  })
  const data = await response.json()
  if (response.status === 429) {
    return { allowed: false, used: data.used, limit: data.limit, remaining: 0, error: data.error, reset_at: data.reset_at }
  }
  if (!response.ok) {
    return { allowed: true, used: 0, limit: 999, remaining: 999 } // fail open
  }
  return { allowed: true, ...data }
}

export async function incrementCallUsage(userId: string | null, minutes: number): Promise<{ limit_reached: boolean; remaining: number }> {
  if (!userId) {
    const { data } = await supabase.auth.getUser()
    userId = data.user?.id ?? null
  }
  if (!userId) return { limit_reached: false, remaining: 999 }
  const response = await fetch('/api/increment-call-usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, minutes }),
  })
  const data = await response.json()
  return { limit_reached: Boolean(data.limit_reached), remaining: data.remaining ?? 0 }
}

export async function sendMessage(
  conversationId: string,
  sender: 'contact' | 'avatar',
  type: MessageType,
  content: string,
  mediaUrl?: string,
  durationSec?: number,
  extra?: {
    localId?: string | null
    transcriptInterim?: string | null
    transcriptFinal?: string | null
    transcriptStatus?: string | null
    audioStatus?: string | null
    audioRetryCount?: number | null
    audioLastError?: string | null
    documentId?: string | null
  }
) {
  const timezone =
    (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC'
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
      localId: extra?.localId ?? null,
      transcriptInterim: extra?.transcriptInterim ?? null,
      transcriptFinal: extra?.transcriptFinal ?? null,
      transcriptStatus: extra?.transcriptStatus ?? null,
      audioStatus: extra?.audioStatus ?? null,
      audioRetryCount: extra?.audioRetryCount ?? null,
      audioLastError: extra?.audioLastError ?? null,
      documentId: extra?.documentId ?? null,
      timezone,
    }),
  })

  const data = await response.json()
  if (!response.ok) {
    throw new Error(data?.error || `sendMessage failed (${response.status})`)
  }
  return data
}

export async function patchMessage(
  messageId: string,
  updates: Record<string, unknown>
) {
  const response = await fetch('/api/send-message', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId, updates }),
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data?.error || `patchMessage failed (${response.status})`)
  }
  return data
}

export async function postAvatarReply(
  payload: Record<string, unknown>,
  options?: { keepalive?: boolean }
) {
  const body = JSON.stringify(payload)
  const primaryUrl = '/api/avatar-reply'
  const fallbackUrl = getCanonicalAppUrl('/api/avatar-reply')
  const urls = fallbackUrl === primaryUrl ? [primaryUrl] : [primaryUrl, fallbackUrl]

  let lastError: unknown = null

  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index]
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: Boolean(options?.keepalive && index === 0),
        cache: 'no-store',
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data?.error || `avatar-reply failed (${response.status})`)
      }
      return { response, data }
    } catch (error) {
      lastError = error
      if (index === urls.length - 1) throw error
      console.warn('[postAvatarReply] primary request failed, retrying canonical URL:', error)
    }
  }

  throw lastError instanceof Error ? lastError : new Error('avatar-reply failed')
}

export async function requestOutboundCall(payload: {
  conversationId: string
  ownerId?: string | null
  contactId?: string | null
  userId?: string | null
  contactEmail: string
  requestedByMessageId?: string | null
  documentIds?: string[]
  triggerText: string
  language?: string | null
  callerDisplayName?: string | null
  delayMinutes?: number
  timezone?: string
}) {
  const timezone =
    payload.timezone ||
    ((typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC')
  const response = await fetch('/api/outbound-call-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, timezone }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data?.error || `outbound-call-request failed (${response.status})`)
  }
  return data as { call: OutboundCallRecord }
}

export async function pollOutboundCall(email: string) {
  const response = await fetch(`/api/outbound-call-poll?email=${encodeURIComponent(email)}`, {
    cache: 'no-store',
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data?.error || `outbound-call-poll failed (${response.status})`)
  }
  return data as { call: OutboundCallRecord | null }
}

export async function respondToOutboundCall(callId: string, action: 'accept' | 'decline') {
  const response = await fetch('/api/outbound-call-respond', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callId, action }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data?.error || `outbound-call-respond failed (${response.status})`)
  }
  return data as {
    call: OutboundCallRecord
    joinUrl: string
    prewarmedSession?: { session_id?: string; join_url?: string; warmed_at?: string } | null
  }
}
