import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { syncChannelState } from './_lib/channelConsistency.js'
import { normalizeCallSummaryText } from './_lib/callSummary.js'

type ChatHistoryMessage = {
  role: 'user' | 'assistant'
  content: string
  msgType: string
}

type MessageType = 'text' | 'voice' | 'video' | 'image' | 'document' | 'flashcard' | 'quiz' | 'lesson' | 'fillin' | 'call_summary' | 'system'

const DEFAULT_JORDAN_OWNER_ID = '77ad10a6-1d73-4201-9e81-e6be996d130a'

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

async function buildDocumentContextForMessage(
  supabase: ReturnType<typeof createClient>,
  conversationId: string,
  query: string,
) {
  const { data: docs } = await supabase
    .from('wa_documents')
    .select('id, file_name')
    .eq('conversation_id', conversationId)
    .eq('extraction_status', 'ready')
    .order('created_at', { ascending: false })
    .limit(4)

  const docIds = (docs || []).map((row: any) => String(row.id || '').trim()).filter(Boolean)
  if (docIds.length === 0) return { text: '', documentIds: [] as string[] }

  const { data: chunks } = await supabase
    .from('wa_document_chunks')
    .select('document_id, chunk_index, content')
    .in('document_id', docIds)
    .limit(240)

  const tokenize = (text: string) =>
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((item) => item.length >= 3)

  const queryTokens = new Set(tokenize(query))
  const ranked = (chunks || [])
    .map((chunk: any) => {
      const content = String(chunk.content || '')
      const score = tokenize(content).reduce((sum, token) => sum + (queryTokens.has(token) ? 1 : 0), 0)
      return { ...chunk, content, score }
    })
    .sort((a: any, b: any) => {
      if (b.score !== a.score) return b.score - a.score
      return Number(a.chunk_index || 0) - Number(b.chunk_index || 0)
    })
    .slice(0, 4)

  const nameById = new Map<string, string>()
  for (const doc of docs || []) {
    nameById.set(String(doc.id || '').trim(), String(doc.file_name || 'Document').trim())
  }

  const lines: string[] = []
  for (const chunk of ranked) {
    const title = nameById.get(String(chunk.document_id || '').trim()) || 'Document'
    lines.push(`[${title}] ${String(chunk.content || '').slice(0, 700)}`)
  }

  if (lines.length === 0) return { text: '', documentIds: docIds }
  return {
    text: `[SHARED DOCUMENT CONTEXT]\n${lines.join('\n\n')}\n\nUse these excerpts when relevant and reference them naturally.`,
    documentIds: docIds,
  }
}

export function mapHistoryRowsToChatHistory(rows: any[], userMessageId?: string | null): ChatHistoryMessage[] {
  return (rows || [])
    .filter((message: any) => !userMessageId || String(message.id) !== String(userMessageId))
    .slice()
    .reverse()
    .map((message: any): ChatHistoryMessage => ({
      role: (message.sender === 'contact' ? 'user' : 'assistant') as 'user' | 'assistant',
      content:
        String(message.type || '') === 'call_summary'
          ? `Call summary: ${normalizeCallSummaryText(message.content)}`
          : String(message.type || '') === 'document'
            ? `[DOCUMENT] ${String(message.content || '').trim()} ${String(message.media_url || '').trim()}`.trim()
          : String(message.content || '').trim(),
      msgType: String(message.type || 'text'),
    }))
    .filter((message: ChatHistoryMessage) => message.content.length > 0)
    .slice(-10)
}

function getAllowedCfoOwnerIds(): Set<string> {
  const fromCsv = String(process.env.CFO_OWNER_IDS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
  const fromSingle = String(process.env.CFO_OWNER_ID || '').trim()
  return new Set([DEFAULT_JORDAN_OWNER_ID, ...fromCsv, ...(fromSingle ? [fromSingle] : [])])
}

function looksFinancialMessage(input: string): boolean {
  const text = String(input || '').toLowerCase()
  if (!text.trim()) return false
  const keywords = [
    'receipt', 'invoice', 'bill', 'expense', 'spend', 'spent', 'cost', 'budget', 'cashflow', 'profit', 'loss', 'tax', 'vat', 'debt', 'payment', 'transaction',
    'quittung', 'rechnung', 'ausgabe', 'kosten', 'budget', 'gewinn', 'verlust', 'steuer', 'mwst', 'zahlung', 'umsatz',
    'recibo', 'factura', 'gasto', 'coste', 'costo', 'presupuesto', 'flujo', 'impuesto', 'iva', 'deuda', 'pago', 'transacción',
    'lira', 'eur', 'usd', 'try', '$', '€', '₺',
  ]
  if (keywords.some((token) => text.includes(token))) return true
  return /(?:\d+[.,]?\d*)\s?(?:eur|usd|try|€|\$|₺)/i.test(text)
}

function parseAmountAndCurrency(input: string): { amount: number | null; currency: string } {
  const text = String(input || '')
  const match = text.match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})|\d+(?:[.,]\d{1,2})?)\s*(€|eur|usd|\$|try|₺|lira)/i)
  if (!match) return { amount: null, currency: 'EUR' }
  const numeric = match[1].replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')
  const amount = Number(numeric)
  const curRaw = match[2].toLowerCase()
  const currency =
    curRaw === '€' || curRaw === 'eur' ? 'EUR' :
    curRaw === '$' || curRaw === 'usd' ? 'USD' :
    curRaw === '₺' || curRaw === 'try' || curRaw === 'lira' ? 'TRY' :
    'EUR'
  return { amount: Number.isFinite(amount) ? Math.abs(amount) : null, currency }
}

async function mirrorFinancialConversationToCfo(params: {
  supabase: ReturnType<typeof createClient>
  ownerId: string
  contactId: string | null
  conversationId: string
  userMessageId: string | null
  userMessage: string
  ownerUserId: string | null
}) {
  const { supabase, ownerId, contactId, conversationId, userMessageId, userMessage, ownerUserId } = params
  if (!contactId) return
  if (!looksFinancialMessage(userMessage)) return

  if (userMessageId) {
    const { data: existing } = await (supabase as any)
      .from('cfo_transactions')
      .select('id')
      .eq('owner_id', ownerId)
      .eq('message_id', userMessageId)
      .limit(1)
      .maybeSingle()
    if ((existing as any)?.id) return
  }

  const parsed = parseAmountAndCurrency(userMessage)
  const shortNote = userMessage.slice(0, 500)
  await (supabase as any).from('cfo_transactions').insert({
    owner_id: ownerId,
    contact_id: contactId,
    conversation_id: conversationId,
    message_id: userMessageId,
    image_url: `wa://financial-message/${userMessageId || crypto.randomUUID()}`,
    merchant: 'Jordan Financial Conversation',
    transaction_date: new Date().toISOString().slice(0, 10),
    total_amount: parsed.amount,
    currency: parsed.currency,
    vat_amount: null,
    category: 'conversation_finance',
    category_confidence: 0.74,
    free_tags: ['conversation', 'financial', 'jordan'],
    line_items: [],
    is_business_expense: false,
    tax_relevant: false,
    payment_method: null,
    notes: shortNote,
    raw_vision_response: {
      source: 'whatsanima.avatar-reply',
      kind: 'financial_conversation_event',
      user_message: shortNote,
      parsed_amount: parsed.amount,
      parsed_currency: parsed.currency,
    },
    extraction_status: 'ok',
    extraction_error: null,
  })

  if (ownerUserId) {
    const cfoEventInsert = await (supabase as any).from('ad_cfo_events').insert({
      user_id: ownerUserId,
      event_type: 'whatsanima_financial_turn',
      source: 'whatsanima.avatar-reply',
      conversation_id: null,
      payload: {
        owner_id: ownerId,
        contact_id: contactId,
        wa_conversation_id: conversationId,
        wa_message_id: userMessageId,
        text: shortNote,
        amount: parsed.amount,
        currency: parsed.currency,
      },
    })
    if (cfoEventInsert?.error) {
      console.warn('[avatar-reply] ad_cfo_events insert failed:', cfoEventInsert.error.message)
    }
  }
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
    timezone,
    options,
  }: {
    conversationId?: string
    userMessage?: string
    userMessageId?: string
    timezone?: string
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
      .select('id, owner_id, contact_id')
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
      .select('id, display_name, voice_id, user_id')
      .eq('id', ownerId)
      .maybeSingle()

    const allowedCfoOwners = getAllowedCfoOwnerIds()
    const isJordanCfoOwner = allowedCfoOwners.has(ownerId)

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
      .select('id, sender, type, content, media_url, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(24)

    const history: ChatHistoryMessage[] = mapHistoryRowsToChatHistory(historyRows || [], userMessageId || null)

    const origin = getOrigin(req)
    if (!origin) {
      return res.status(500).json({ error: 'Unable to resolve API origin' })
    }

    await syncChannelState({
      supabase,
      conversationId,
      channel: options?.isVoice ? 'voice' : options?.isVideo ? 'video' : 'chat',
      timezone: String(timezone || 'UTC'),
      messageText: userMessage,
    })

    const documentContext = await buildDocumentContextForMessage(
      supabase,
      conversationId,
      userMessage,
    )

    const chatResponse = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: userMessage,
        conversationId,
        ownerId,
        ownerName: ownerRow?.display_name || null,
        metadata: { timezone: String(timezone || 'UTC') },
        timezone: String(timezone || 'UTC'),
        history,
        image_url: options?.imageUrl,
        isImage: Boolean(options?.isImage),
        isVideo: Boolean(options?.isVideo),
        isVoice: Boolean(options?.isVoice),
        perception: options?.perception ?? null,
        userMessageId: userMessageId || null,
        documentContext: documentContext.text || null,
        documentIds: documentContext.documentIds,
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

    if (isJordanCfoOwner && !options?.isImage) {
      await mirrorFinancialConversationToCfo({
        supabase,
        ownerId,
        contactId: conversationRow?.contact_id ? String(conversationRow.contact_id) : null,
        conversationId,
        userMessageId: userMessageId || null,
        userMessage,
        ownerUserId: ownerRow?.user_id ? String(ownerRow.user_id) : null,
      }).catch((err) => {
        console.warn('[avatar-reply][cfo-sync] failed:', err instanceof Error ? err.message : err)
      })
    }

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
