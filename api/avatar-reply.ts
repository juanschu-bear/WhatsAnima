import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

type ChatHistoryMessage = {
  role: 'user' | 'assistant'
  content: string
  msgType: string
}

type MessageType = 'text' | 'voice' | 'video' | 'image' | 'flashcard' | 'quiz' | 'lesson' | 'fillin' | 'call_summary' | 'system'

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

function getOrigin(req: any) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
  const host = forwardedHost || String(req.headers.host || '').trim()
  const proto = forwardedProto || 'http'
  if (!host) return null
  return `${proto}://${host}`
}

function parseSpecialType(content: string): MessageType | null {
  const match = content.match(/```(flashcard|quiz|lesson|fillin)\s*\n?[\s\S]*?\n?```/)
  return match ? (match[1] as MessageType) : null
}

function sanitizeContent(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return ''
  return text.replace(/```generate_image\s*\n?[\s\S]*?\n?```/g, '').trim()
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

  const {
    conversationId,
    userMessage,
    userMessageId,
    options,
  }: {
    conversationId?: string
    userMessage?: string
    userMessageId?: string
    options?: {
      useVoice?: boolean
      imageUrl?: string
      isImage?: boolean
      isVideo?: boolean
      isVoice?: boolean
      perception?: any
    }
  } = req.body ?? {}

  if (!conversationId || !userMessage || typeof userMessage !== 'string') {
    return res.status(400).json({ error: 'conversationId and userMessage are required' })
  }

  try {
    const { data: conversationRow, error: conversationError } = await supabase
      .from('wa_conversations')
      .select('id, owner_id')
      .eq('id', conversationId)
      .maybeSingle()

    if (conversationError) {
      return res.status(500).json({ error: conversationError.message })
    }
    if (!conversationRow?.owner_id) {
      return res.status(404).json({ error: 'Conversation not found' })
    }

    const ownerId = String(conversationRow.owner_id)
    const { data: ownerRow } = await supabase
      .from('wa_owners')
      .select('id, display_name, voice_id')
      .eq('id', ownerId)
      .maybeSingle()

    // Idempotency: if we already produced an avatar reply after this user message,
    // return it instead of generating again.
    if (userMessageId) {
      const { data: userMsg } = await supabase
        .from('wa_messages')
        .select('created_at')
        .eq('id', userMessageId)
        .maybeSingle()

      if (userMsg?.created_at) {
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
          return res.status(200).json({ ok: true, deduplicated: true, messages: [existingReply] })
        }
      }
    }

    const { data: historyRows } = await supabase
      .from('wa_messages')
      .select('sender, type, content, created_at')
      .eq('conversation_id', conversationId)
      .neq('type', 'call_summary')
      .order('created_at', { ascending: false })
      .limit(10)

    const history: ChatHistoryMessage[] = (historyRows || [])
      .slice()
      .reverse()
      .map((message: any) => ({
        role: message.sender === 'contact' ? 'user' : 'assistant',
        content: String(message.content || '').trim(),
        msgType: String(message.type || 'text'),
      }))
      .filter((message) => message.content.length > 0)

    const origin = getOrigin(req)
    if (!origin) {
      return res.status(500).json({ error: 'Unable to resolve API origin' })
    }

    const chatResponse = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: userMessage,
        conversationId,
        ownerId,
        ownerName: ownerRow?.display_name || null,
        history,
        image_url: options?.imageUrl,
        isImage: Boolean(options?.isImage),
        isVideo: Boolean(options?.isVideo),
        isVoice: Boolean(options?.isVoice),
        perception: options?.perception ?? null,
        userMessageId: userMessageId || null,
      }),
    })

    const chatData = await chatResponse.json().catch(() => ({}))
    if (!chatResponse.ok) {
      const reason = typeof chatData?.error === 'string' ? chatData.error : `Chat API returned ${chatResponse.status}`
      return res.status(502).json({ error: reason })
    }

    const replyText = sanitizeContent(chatData?.content)
    const generatedImageUrl =
      typeof chatData?.image_url === 'string' && chatData.image_url.trim().length > 0
        ? chatData.image_url.trim()
        : null
    const useVoice = options?.useVoice ?? true
    const insertedMessages: any[] = []
    let transcript: string | null = null

    const insertMessage = async (payload: {
      type: MessageType
      content: string | null
      media_url?: string | null
    }) => {
      const { data, error } = await supabase
        .from('wa_messages')
        .insert({
          conversation_id: conversationId,
          sender: 'avatar',
          type: payload.type,
          content: payload.content,
          media_url: payload.media_url ?? null,
        })
        .select()
        .single()
      if (error) throw new Error(error.message)
      insertedMessages.push(data)
      return data
    }

    if (generatedImageUrl) {
      if (replyText) {
        await insertMessage({ type: 'text', content: replyText })
      }
      await insertMessage({ type: 'image', content: '', media_url: generatedImageUrl })
    } else {
      const content = replyText || 'Honestly? Give me the interesting part first.'
      const specialType = parseSpecialType(content)
      if (specialType) {
        await insertMessage({ type: specialType, content })
      } else if (useVoice) {
        const ttsResponse = await fetch(`${origin}/api/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: content,
            ...(ownerRow?.voice_id ? { voiceId: ownerRow.voice_id } : {}),
          }),
        })
        if (!ttsResponse.ok) {
          const ttsError = await ttsResponse.json().catch(() => ({}))
          const reason = typeof ttsError?.error === 'string' ? ttsError.error : `TTS HTTP ${ttsResponse.status}`
          throw new Error(reason)
        }

        const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer())
        if (!audioBuffer.length) {
          throw new Error('TTS returned empty audio')
        }

        const path = `${conversationId}/avatar-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp3`
        await supabase.storage.createBucket('voice-messages', { public: true }).catch(() => undefined)
        const { error: uploadError } = await supabase.storage
          .from('voice-messages')
          .upload(path, audioBuffer, { contentType: 'audio/mpeg', upsert: true })
        if (uploadError) throw new Error(uploadError.message)

        const { data: urlData } = supabase.storage.from('voice-messages').getPublicUrl(path)
        await insertMessage({ type: 'voice', content, media_url: urlData.publicUrl })
        transcript = content
      } else {
        await insertMessage({ type: 'text', content })
      }
    }

    await supabase
      .from('wa_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId)

    return res.status(200).json({
      ok: true,
      messages: insertedMessages,
      transcript,
      videoTopics: Array.isArray(chatData?.video_topics) ? chatData.video_topics : [],
      videoSuggestions: Array.isArray(chatData?.video_suggestions) ? chatData.video_suggestions : [],
    })
  } catch (error: any) {
    console.error('[avatar-reply] Error:', error?.message || error)
    return res.status(500).json({ error: error?.message || 'Failed to create avatar reply' })
  }
}
