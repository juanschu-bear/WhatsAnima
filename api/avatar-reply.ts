import {
  callAnthropic,
  loadOwnerPromptAndMemory,
  buildSystemPrompt,
  prepareMessages,
  generateImageFromPrompt,
  ChatMessage,
} from './chat'
import { createClient } from '@supabase/supabase-js'
import * as webpush from 'web-push'

const TTS_MAX_RETRIES = 3
const TTS_RETRY_BASE_MS = 2000
const VOICE_PLACEHOLDERS = ['a voice message', '[Voice message]', 'Voice note', '[voice message]']

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY
  if (!url) return { client: null, missing: 'SUPABASE_URL' }
  if (!key) return { client: null, missing: 'SUPABASE_SERVICE_KEY' }
  return { client: createClient(url, key), missing: null }
}

/** Call ElevenLabs TTS and return the raw audio buffer, or null on failure. */
async function textToSpeech(text: string, voiceId?: string): Promise<Buffer | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY || process.env.VITE_ELEVENLABS_API_KEY
  if (!apiKey) {
    console.warn('[avatar-reply] No ElevenLabs API key — skipping TTS')
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
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: payload,
    })

    if (elRes.status === 429 && attempt < TTS_MAX_RETRIES) {
      const waitMs = TTS_RETRY_BASE_MS * attempt
      console.warn(`[avatar-reply] TTS rate limited, retry ${attempt}/${TTS_MAX_RETRIES} in ${waitMs}ms`)
      await new Promise((r) => setTimeout(r, waitMs))
      continue
    }

    if (!elRes.ok) {
      console.error('[avatar-reply] TTS error:', elRes.status, await elRes.text().catch(() => ''))
      return null
    }

    return Buffer.from(await elRes.arrayBuffer())
  }

  return null
}

/** Upload an audio buffer to Supabase storage and return the public URL. */
async function uploadAudio(
  supabase: ReturnType<typeof createClient>,
  buffer: Buffer,
  conversationId: string
): Promise<string | null> {
  const filename = `voice/${conversationId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`

  const { error } = await supabase.storage
    .from('media')
    .upload(filename, buffer, { contentType: 'audio/mpeg', upsert: false })

  if (error) {
    console.error('[avatar-reply] Audio upload error:', error.message)
    return null
  }

  const { data } = supabase.storage.from('media').getPublicUrl(filename)
  return data.publicUrl
}

/** Send push notifications to all of a user's subscribed devices. Fire-and-forget. */
async function sendPushNotification(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  title: string,
  body: string,
  conversationId: string
) {
  const vapidPublic = process.env.VAPID_PUBLIC_KEY
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY
  if (!vapidPublic || !vapidPrivate) return

  const vapidEmail = process.env.VAPID_EMAIL || 'mailto:hello@whatsanima.com'
  webpush.setVapidDetails(vapidEmail, vapidPublic, vapidPrivate)

  const { data: subs } = await supabase
    .from('wa_push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('user_id', userId)

  if (!subs || subs.length === 0) return

  const payload = JSON.stringify({
    title,
    body: body.slice(0, 100),
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

  if (staleEndpoints.length > 0) {
    await supabase.from('wa_push_subscriptions').delete().in('endpoint', staleEndpoints)
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' })
  }

  const { client: supabase, missing } = getSupabaseAdmin()
  if (!supabase) {
    return res.status(503).json({ error: `DB not configured – missing ${missing}` })
  }

  let {
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
  }: {
    message?: string
    conversationId?: string
    history?: ChatMessage[]
    image_url?: string
    isImage?: boolean
    isVideo?: boolean
    isVoice?: boolean
    perception?: any
    userMessageId?: string
    useVoice?: boolean
    voiceId?: string
  } = req.body ?? {}

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message content is required' })
  }

  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId is required' })
  }

  // --- Voice transcript resolution ---
  if (isVoice && userMessageId && VOICE_PLACEHOLDERS.includes(message.trim())) {
    const { data: msgRow } = await supabase
      .from('wa_messages')
      .select('content')
      .eq('id', userMessageId)
      .maybeSingle()

    if (msgRow?.content && !VOICE_PLACEHOLDERS.includes(msgRow.content.trim())) {
      message = msgRow.content
    } else {
      const { data: logRow } = await supabase
        .from('wa_perception_logs')
        .select('transcript')
        .eq('message_id', userMessageId)
        .maybeSingle()

      if (logRow?.transcript) {
        message = logRow.transcript
      }
    }
  }

  // --- Duplicate check ---
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
        .limit(5)

      if (existingReply && existingReply.length > 0) {
        console.log('[avatar-reply] Dedup: reply already exists for message', userMessageId)
        return res.status(200).json({ messages: existingReply, _deduplicated: true })
      }
    }
  }

  // --- Build messages and call Claude ---
  const priorMessages = Array.isArray(history)
    ? history.filter(
        (entry): entry is ChatMessage =>
          Boolean(entry) &&
          (entry.role === 'user' || entry.role === 'assistant') &&
          typeof entry.content === 'string' &&
          entry.content.trim().length > 0
      )
    : []

  try {
    const { ownerPrompt, memory, stylePrompt, behavioralMemory } =
      await loadOwnerPromptAndMemory(conversationId)
    const systemPrompt = buildSystemPrompt(ownerPrompt, memory, stylePrompt, behavioralMemory, perception)
    const messages = prepareMessages(priorMessages, message, { image_url, isImage, isVideo, isVoice })

    let content = await callAnthropic(apiKey, systemPrompt, messages)
    if (!content) {
      return res.status(502).json({ error: 'Empty response from AI' })
    }

    const savedMessages: any[] = []

    // --- Handle image generation block ---
    const imageMatch = content.match(/```generate_image\s*\n?([\s\S]*?)\n?```/)
    let generatedImageUrl: string | null = null

    if (imageMatch) {
      const imagePrompt = imageMatch[1].trim()
      content = content.replace(/```generate_image\s*\n?[\s\S]*?\n?```/, '').trim()
      generatedImageUrl = await generateImageFromPrompt(imagePrompt, conversationId)

      if (!generatedImageUrl) {
        console.error('[avatar-reply] Image generation failed for prompt:', imagePrompt.slice(0, 100))
        if (!content) {
          content = 'Sorry, the image could not be generated right now. Please try again.'
        }
      }
    }

    // --- TTS if requested ---
    let audioUrl: string | null = null
    if (useVoice && content) {
      const audioBuffer = await textToSpeech(content, voiceId)
      if (audioBuffer) {
        audioUrl = await uploadAudio(supabase, audioBuffer, conversationId)
      }
    }

    // --- Save text/voice message to DB ---
    if (audioUrl && content) {
      const { data: voiceMsg, error: voiceErr } = await supabase
        .from('wa_messages')
        .insert({
          conversation_id: conversationId,
          sender: 'avatar',
          type: 'voice',
          content,
          media_url: audioUrl,
        })
        .select()
        .single()

      if (voiceErr) {
        console.error('[avatar-reply] Voice message insert error:', voiceErr.message)
      } else if (voiceMsg) {
        savedMessages.push(voiceMsg)
      }
    } else if (content) {
      const { data: textMsg, error: textErr } = await supabase
        .from('wa_messages')
        .insert({
          conversation_id: conversationId,
          sender: 'avatar',
          type: 'text',
          content,
        })
        .select()
        .single()

      if (textErr) {
        console.error('[avatar-reply] Text message insert error:', textErr.message)
      } else if (textMsg) {
        savedMessages.push(textMsg)
      }
    }

    // --- Save generated image as separate message ---
    if (generatedImageUrl) {
      const { data: imgMsg, error: imgErr } = await supabase
        .from('wa_messages')
        .insert({
          conversation_id: conversationId,
          sender: 'avatar',
          type: 'image',
          content: content || null,
          media_url: generatedImageUrl,
        })
        .select()
        .single()

      if (imgErr) {
        console.error('[avatar-reply] Image message insert error:', imgErr.message)
      } else if (imgMsg) {
        savedMessages.push(imgMsg)
      }
    }

    // --- Update conversation timestamp ---
    await supabase
      .from('wa_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId)

    // --- Push notification (fire-and-forget) ---
    const { data: convRow } = await supabase
      .from('wa_conversations')
      .select('contact_id, wa_owners(display_name)')
      .eq('id', conversationId)
      .single()

    if (convRow?.contact_id) {
      const { data: contactRow } = await supabase
        .from('wa_contacts')
        .select('user_id')
        .eq('id', convRow.contact_id)
        .single()

      if (contactRow?.user_id) {
        const avatarName = (convRow as any).wa_owners?.display_name || 'Avatar'
        const preview =
          savedMessages.length > 0 && savedMessages[savedMessages.length - 1].type === 'image'
            ? 'Sent an image'
            : (content || '').slice(0, 100)

        sendPushNotification(supabase, contactRow.user_id, avatarName, preview, conversationId).catch(
          (err) => console.error('[avatar-reply] Push error:', err.message)
        )
      }
    }

    if (savedMessages.length === 0) {
      return res.status(502).json({ error: 'Failed to save reply messages' })
    }

    return res.status(200).json({ messages: savedMessages })
  } catch (error: any) {
    console.error('[avatar-reply] Error:', error.message || error)
    return res.status(500).json({ error: 'Avatar reply processing failed' })
  }
}
