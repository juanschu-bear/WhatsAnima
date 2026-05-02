import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'

const DEFAULT_JORDAN_OWNER_ID = '77ad10a6-1d73-4201-9e81-e6be996d130a'

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url) return { client: null, missing: 'SUPABASE_URL' }
  if (!key) return { client: null, missing: 'SUPABASE_SERVICE_ROLE_KEY' }
  return { client: createClient(url, key), missing: null }
}

function allowedOwnerIds(): Set<string> {
  const fromCsv = String(process.env.CFO_OWNER_IDS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
  const fromSingle = String(process.env.CFO_OWNER_ID || '').trim()
  return new Set([DEFAULT_JORDAN_OWNER_ID, ...fromCsv, ...(fromSingle ? [fromSingle] : [])])
}

function parseAmountAndCurrency(input: string): { amount: number | null; currency: string } {
  const text = String(input || '')
  const match = text.match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})|\d+(?:[.,]\d{1,2})?)\s*(€|eur|usd|\$|try|₺|lira)/i)
  if (!match) return { amount: null, currency: 'EUR' }
  const normalized = match[1].replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')
  const amount = Number(normalized)
  const curRaw = match[2].toLowerCase()
  const currency =
    curRaw === '€' || curRaw === 'eur' ? 'EUR' :
    curRaw === '$' || curRaw === 'usd' ? 'USD' :
    curRaw === '₺' || curRaw === 'try' || curRaw === 'lira' ? 'TRY' :
    'EUR'
  return { amount: Number.isFinite(amount) ? Math.abs(amount) : null, currency }
}

async function mirrorToAnimaDriveManualEntry(params: {
  supabase: ReturnType<typeof createClient>
  ownerUserId: string
  ownerId: string
  contactId: string
  conversationId: string
  userMessageId: string | null
  text: string
  amount: number | null
  currency: string
}) {
  const { supabase, ownerUserId, ownerId, contactId, conversationId, userMessageId, text, amount, currency } = params
  const documentId = crypto.randomUUID()
  const nowIso = new Date().toISOString()
  const dateOnly = nowIso.slice(0, 10)
  const storagePath = `${ownerUserId}/${documentId}.txt`
  const filename = `Manual Finance Entry ${dateOnly}.txt`
  const displayName = `Manual Finance Entry ${dateOnly}`
  const fileBody = [
    `Date: ${dateOnly}`,
    `Owner ID: ${ownerId}`,
    `Contact ID: ${contactId}`,
    `Conversation ID: ${conversationId}`,
    `Message ID: ${userMessageId || 'n/a'}`,
    `Amount: ${amount != null ? amount.toFixed(2) : 'n/a'} ${currency}`,
    '',
    'Original user note:',
    text,
    '',
  ].join('\n')

  const upload = await supabase.storage
    .from('ad-docs')
    .upload(storagePath, Buffer.from(fileBody, 'utf-8'), { contentType: 'text/plain; charset=utf-8', upsert: true })
  if (upload.error) throw new Error(`manual entry upload failed: ${upload.error.message}`)

  const docInsert = await supabase.from('ad_documents').insert({
    id: documentId,
    user_id: ownerUserId,
    filename,
    display_name: displayName,
    ext: 'txt',
    size_bytes: Buffer.byteLength(fileBody, 'utf-8'),
    storage_path: storagePath,
    mime_type: 'text/plain',
    category_key: 'cat_expenses',
    category_confidence: 0.82,
    status: 'ready',
    uploaded_at: nowIso,
    categorized_at: nowIso,
    extracted_at: nowIso,
  })
  if (docInsert.error) throw new Error(`manual entry ad_documents insert failed: ${docInsert.error.message}`)

  const extractionInsert = await supabase.from('ad_extractions').insert({
    document_id: documentId,
    document_type: 'financial',
    summary: 'Manual financial entry logged from WhatsAnima chat.',
    metadata: {
      source: 'whatsanima.cfo-financial-turn',
      kind: 'manual_finance_entry',
      owner_id: ownerId,
      contact_id: contactId,
      wa_conversation_id: conversationId,
      wa_message_id: userMessageId,
    },
    vendor: 'Manual Entry',
    doc_date: dateOnly,
    total_amount: amount,
    currency,
    vat_amount: null,
    invoice_number: null,
    due_date: null,
    payment_terms: null,
    raw_extraction: {
      source: 'whatsanima.cfo-financial-turn',
      text,
      amount,
      currency,
    },
  })
  if (extractionInsert.error) throw new Error(`manual entry ad_extractions insert failed: ${extractionInsert.error.message}`)

  await supabase.from('ad_activities').insert([
    {
      user_id: ownerUserId,
      document_id: documentId,
      type: 'categorized',
      message: `Categorized ${displayName} as cat_expenses`,
      metadata: { source: 'whatsanima', kind: 'manual_finance_entry' },
    },
    {
      user_id: ownerUserId,
      document_id: documentId,
      type: 'extracted',
      message: `Extracted financial document: ${displayName}`,
      metadata: { source: 'whatsanima', kind: 'manual_finance_entry' },
    },
  ]).catch(() => undefined)

  return { documentId, storagePath }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { client: supabase, missing } = getSupabaseAdmin()
  if (!supabase) return res.status(503).json({ error: `DB not configured – missing ${missing}` })

  const {
    conversationId,
    ownerId,
    contactId,
    userMessageId,
    text,
  }: {
    conversationId?: string
    ownerId?: string
    contactId?: string
    userMessageId?: string | null
    text?: string
  } = req.body ?? {}

  if (!conversationId || !ownerId || !contactId || !text) {
    return res.status(400).json({ error: 'conversationId, ownerId, contactId and text are required' })
  }

  if (!allowedOwnerIds().has(ownerId)) {
    return res.status(200).json({ ok: true, skipped: 'owner-not-allowed' })
  }

  const shortText = String(text).trim().slice(0, 500)
  if (!shortText) return res.status(400).json({ error: 'text cannot be empty' })

  try {
    if (userMessageId) {
      const { data: existing } = await supabase
        .from('cfo_transactions')
        .select('id')
        .eq('owner_id', ownerId)
        .eq('message_id', userMessageId)
        .limit(1)
        .maybeSingle()
      if (existing?.id) return res.status(200).json({ ok: true, deduplicated: true })
    }

    const { amount, currency } = parseAmountAndCurrency(shortText)

    const { data: ownerRow } = await supabase
      .from('wa_owners')
      .select('id, user_id')
      .eq('id', ownerId)
      .maybeSingle()

    let mirroredStoragePath: string | null = null
    if (ownerRow?.user_id) {
      try {
        const mirrored = await mirrorToAnimaDriveManualEntry({
          supabase,
          ownerUserId: String(ownerRow.user_id),
          ownerId,
          contactId,
          conversationId,
          userMessageId: userMessageId || null,
          text: shortText,
          amount,
          currency,
        })
        mirroredStoragePath = mirrored.storagePath
      } catch (mirrorErr: any) {
        console.warn('[cfo-financial-turn] anima-drive mirror failed:', mirrorErr?.message || mirrorErr)
      }
    }

    await supabase.from('cfo_transactions').insert({
      owner_id: ownerId,
      contact_id: contactId,
      conversation_id: conversationId,
      message_id: userMessageId || null,
      image_url: `wa://financial-message/${userMessageId || crypto.randomUUID()}`,
      drive_url: mirroredStoragePath,
      merchant: 'Jordan Financial Conversation',
      transaction_date: new Date().toISOString().slice(0, 10),
      total_amount: amount,
      currency,
      vat_amount: null,
      category: 'conversation_finance',
      category_confidence: 0.74,
      free_tags: ['conversation', 'financial', 'jordan', 'log_only'],
      line_items: [],
      is_business_expense: false,
      tax_relevant: false,
      payment_method: null,
      notes: shortText,
      raw_vision_response: {
        source: 'whatsanima.cfo-financial-turn',
        kind: 'financial_conversation_event',
        user_message: shortText,
        parsed_amount: amount,
        parsed_currency: currency,
      },
      extraction_status: 'ok',
      extraction_error: null,
    })

    if (ownerRow?.user_id) {
      await supabase.from('ad_cfo_events').insert({
        user_id: String(ownerRow.user_id),
        event_type: 'whatsanima_financial_turn',
        source: 'whatsanima.cfo-financial-turn',
        conversation_id: null,
        payload: {
          owner_id: ownerId,
          contact_id: contactId,
          wa_conversation_id: conversationId,
          wa_message_id: userMessageId || null,
          text: shortText,
          amount,
          currency,
        },
      }).catch(() => undefined)
    }

    return res.status(200).json({ ok: true, amount, currency, drive_url: mirroredStoragePath })
  } catch (error: any) {
    console.error('[cfo-financial-turn] Error:', error?.message || error)
    return res.status(500).json({ error: error?.message || 'Failed to ingest financial turn' })
  }
}
