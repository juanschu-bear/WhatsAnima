import { createClient } from '@supabase/supabase-js'
import webpush from 'web-push'
import {
  callAnthropic,
  loadOwnerPromptAndMemory,
  buildSystemPrompt,
  prepareMessages,
  generateImageFromPrompt,
  ChatMessage,
} from './chat'

const TTS_MAX_RETRIES = 3
const TTS_RETRY_BASE_MS = 2000

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

async function generateTTS(text: string, voiceId?: string): Promise<Buffer | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY || process.env.VITE_ELEVENLABS_API_KEY
  if (!apiKey) {
    console.error('[avatar-reply] No ElevenLabs API key')
    return null
  }

  const voice = voiceId || 'lx8LAX2EUAKftVz0Dk5z'
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}`
  const payload = JSON.stringify({
    text,
    model_id: 'eleven_multilingual_v2',
    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
  })

  for (let attempt = 1; attempt <= TTS_MAX_RETRIES; attempt++) {
    const elRes = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: payload,
    })

    if (elRes.status === 429 && attempt < TTS_MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, TTS_RETRY_BASE_MS * attempt))
      continue
    }

    if (!elRes.ok) {
      console.error('[avatar-reply] TTS error:', elRes.status)
      return null
    }

    return Buffer.from(await elRes.arrayBuffer())
  }

  return null
}

async function uploadAudioBuffer(supabase: ReturnType<typeof createClient>, conversationId: string, buffer: Buffer): Promise<string | null> {
  const filename = `${conversationId}/voice-${Date.now()}.mp3`
  const { error } = await supabase.storage
    .from('voice-messages')
    .upload(filename, buffer, { contentType: 'audio/mpeg', upsert: true })

  if (error) {
    console.error('[avatar-reply] Audio upload error:', error.message)
    return null
  }

  const { data } = supabase.storage.from('voice-messages').getPublicUrl(filename)
  return data.publicUrl
}

/**
 * Send a Web Push notification to the contact of a conversation.
 * Looks up contact email → auth user → push subscriptions.
 * Fire-and-forget: errors are logged but never block the response.
 */
async function sendPushToContact(
  supabase: ReturnType<typeof createClient>,
  conversationId: string,
  avatarName: string,
  messagePreview: string
) {
  const vapidPublic = process.env.VAPID_PUBLIC_KEY
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY
  const vapidEmail = process.env.VAPID_EMAIL || 'mailto:hello@whatsanima.com'
  if (!vapidPublic || !vapidPrivate) return

  try {
    // 1. Get contact email and owner name from conversation
    const { data: conv } = await supabase
      .from('wa_conversations')
      .select('contact_id, owner_id')
      .eq('id', conversationId)
      .single()
    if (!conv?.contact_id) return

    const { data: contact } = await supabase
      .from('wa_contacts')
      .select('email')
      .eq('id', conv.contact_id)
      .single()
    if (!contact?.email) return

    // Get avatar display name for the notification title
    if (!avatarName && conv.owner_id) {
      const { data: owner } = await supabase
        .from('wa_owners')
        .select('display_name')
        .eq('id', conv.owner_id)
        .single()
      if (owner?.display_name) avatarName = owner.display_name
    }

    // 2. Find auth user by email
    const { data: authData } = await supabase.auth.admin.listUsers()
    const authUser = authData?.users?.find(
      (u: any) => u.email?.toLowerCase() === contact.email.toLowerCase()
    )
    if (!authUser) return

    // 3. Fetch push subscriptions for this user
    const { data: subs } = await supabase
      .from('wa_push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('user_id', authUser.id)
    if (!subs || subs.length === 0) return

    // 4. Send push notifications
    webpush.setVapidDetails(vapidEmail, vapidPublic, vapidPrivate)
    const payload = JSON.stringify({
      title: avatarName,
      body: messagePreview,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: `wa-msg-${conversationId}`,
      url: `/chat/${conversationId}`,
      conversationId,
      sound: 'chime',
    })

    const staleEndpoints: string[] = []
    await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload
          )
        } catch (err: any) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            staleEndpoints.push(sub.endpoint)
          }
        }
      })
    )

    // Cleanup stale subscriptions
    if (staleEndpoints.length > 0) {
      await supabase.from('wa_push_subscriptions').delete().in('endpoint', staleEndpoints)
    }
  } catch (err: any) {
    console.warn('[avatar-reply] Push notification failed (non-blocking):', err.message)
  }
}

async function saveMessage(
  supabase: ReturnType<typeof createClient>,
  conversationId: string,
  type: string,
  content: string,
  mediaUrl?: string | null
) {
  const { data, error } = await supabase
    .from('wa_messages')
    .insert({
      conversation_id: conversationId,
      sender: 'avatar',
      type,
      content: content || null,
      media_url: mediaUrl || null,
    })
    .select()
    .single()

  if (error) throw new Error(`DB insert failed: ${error.message}`)

  // Update conversation timestamp
  await supabase
    .from('wa_conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId)
    .then(() => {})
    .catch((err: any) => console.warn('[avatar-reply] Conversation timestamp update failed:', err.message))

  return data
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' })

  const {
    message,
    conversationId,
    history,
    image_url,
    isImage,
    isVideo,
    isVoice,
    perception,
    userMessageId,
    useVoice,
    voiceId,
  } = req.body ?? {}

  if (!message || !conversationId) {
    return res.status(400).json({ error: 'message and conversationId are required' })
  }

  const supabase = getSupabase()
  if (!supabase) return res.status(503).json({ error: 'DB not configured' })

  // --- Duplicate check: if an avatar reply already exists for this user message, return it ---
  if (userMessageId) {
    const { data: userMsg } = await supabase
      .from('wa_messages')
      .select('created_at')
      .eq('id', userMessageId)
      .maybeSingle()

    if (userMsg) {
      const { data: existingReply } = await supabase
        .from('wa_messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .eq('sender', 'avatar')
        .gt('created_at', userMsg.created_at)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()

      if (existingReply) {
        console.log('[avatar-reply] Dedup: reply already exists for message', userMessageId)
        return res.status(200).json({ messages: [existingReply], _deduplicated: true })
      }
    }
  }

  // --- Voice transcript resolution ---
  let resolvedMessage = message
  const VOICE_PLACEHOLDERS = ['a voice message', '[Voice message]', 'Voice note', '[voice message]']
  if (isVoice && userMessageId && VOICE_PLACEHOLDERS.includes(message.trim())) {
    const { data: msgRow } = await supabase
      .from('wa_messages')
      .select('content')
      .eq('id', userMessageId)
      .maybeSingle()

    if (msgRow?.content && !VOICE_PLACEHOLDERS.includes(msgRow.content.trim())) {
      resolvedMessage = msgRow.content
    } else {
      const { data: logRow } = await supabase
        .from('wa_perception_logs')
        .select('transcript')
        .eq('message_id', userMessageId)
        .maybeSingle()
      if (logRow?.transcript) resolvedMessage = logRow.transcript
    }
  }

  try {
    // --- 1. Generate AI response ---
    const priorMessages: ChatMessage[] = Array.isArray(history)
      ? history.filter(
          (entry: any): entry is ChatMessage =>
            Boolean(entry) &&
            (entry.role === 'user' || entry.role === 'assistant') &&
            typeof entry.content === 'string' &&
            entry.content.trim().length > 0
        )
      : []

    const { ownerPrompt, memory, stylePrompt, behavioralMemory } = await loadOwnerPromptAndMemory(conversationId)
    const systemPrompt = buildSystemPrompt(ownerPrompt, memory, stylePrompt, behavioralMemory, perception)
    const messages = prepareMessages(priorMessages, resolvedMessage, { image_url, isImage, isVideo, isVoice })

    let replyText = await callAnthropic(apiKey, systemPrompt, messages)
    if (!replyText) {
      return res.status(502).json({ error: 'Empty response from AI' })
    }

    // Strip leaked generate_image blocks from text
    if (replyText.includes('```generate_image')) {
      replyText = replyText.replace(/```generate_image\s*\n?[\s\S]*?\n?```/g, '').trim()
    }
    if (!replyText) replyText = 'Honestly? Give me the interesting part first.'

    // --- 2. Handle image generation ---
    const imageMatch = replyText.match(/```generate_image\s*\n?([\s\S]*?)\n?```/)
    if (imageMatch) {
      const imagePrompt = imageMatch[1].trim()
      const textPart = replyText.replace(/```generate_image\s*\n?[\s\S]*?\n?```/, '').trim()
      const generatedImageUrl = await generateImageFromPrompt(imagePrompt, conversationId)

      const savedMessages = []
      if (textPart) {
        savedMessages.push(await saveMessage(supabase, conversationId, 'text', textPart))
      }
      if (generatedImageUrl) {
        savedMessages.push(await saveMessage(supabase, conversationId, 'image', '', generatedImageUrl))
      } else if (!textPart) {
        savedMessages.push(await saveMessage(supabase, conversationId, 'text', 'Sorry, the image could not be generated right now. Please try again.'))
      }

      // Fire-and-forget push notification
      const imgPreview = textPart || 'Sent an image'
      sendPushToContact(supabase, conversationId, '', imgPreview.slice(0, 100)).catch(() => {})

      return res.status(200).json({ messages: savedMessages })
    }

    // --- 3. Detect special message types ---
    const specialMatch = replyText.match(/```(flashcard|quiz|lesson|fillin)\s*\n?[\s\S]*?\n?```/)
    const specialType = specialMatch ? specialMatch[1] : null

    // --- 4. Generate TTS if needed ---
    let audioUrl: string | null = null
    const shouldUseVoice = !specialType && (useVoice ?? true)

    if (shouldUseVoice) {
      const audioBuffer = await generateTTS(replyText, voiceId)
      if (audioBuffer && audioBuffer.length > 0) {
        audioUrl = await uploadAudioBuffer(supabase, conversationId, audioBuffer)
      }
    }

    // --- 5. Save message to DB ---
    const msgType = specialType ?? (audioUrl ? 'voice' : 'text')
    const saved = await saveMessage(supabase, conversationId, msgType, replyText, audioUrl)

    // Fire-and-forget push notification
    const preview = replyText.split('\n')[0].slice(0, 100)
    sendPushToContact(supabase, conversationId, '', preview).catch(() => {})

    return res.status(200).json({ messages: [saved] })
  } catch (error: any) {
    console.error('[avatar-reply] Pipeline failed:', error.message || error)
    return res.status(500).json({ error: 'Avatar reply failed' })
  }
}
