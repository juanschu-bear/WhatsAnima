import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'
import { extractReceipt } from './_lib/receiptExtraction.js'

const JORDAN_CASH_OWNER_ID = '77ad10a6-1d73-4201-9e81-e6be996d130a'

function allowedOwnerIds(): string[] {
  const fromCsv = String(process.env.CFO_OWNER_IDS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
  const fromSingle = String(process.env.CFO_OWNER_ID || '').trim()
  const merged = [...fromCsv, ...(fromSingle ? [fromSingle] : []), JORDAN_CASH_OWNER_ID]
  return [...new Set(merged)]
}

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url) return { client: null, missing: 'SUPABASE_URL' }
  if (!key) return { client: null, missing: 'SUPABASE_SERVICE_ROLE_KEY' }
  return { client: createClient(url, key), missing: null }
}

function extFromMime(contentType: string | null): string {
  const mime = (contentType || '').toLowerCase()
  if (mime.includes('png')) return 'png'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('heic')) return 'heic'
  if (mime.includes('gif')) return 'gif'
  return 'jpg'
}

function mapCfoToAdCategory(category: string): string {
  const byKey: Record<string, string> = {
    software_abos: 'cat_software',
    ai_abos: 'cat_software',
    reisen: 'cat_travel',
    marketing: 'cat_marketing',
    bueromaterial: 'cat_office',
    hardware: 'cat_office',
    transport: 'cat_vehicle',
    unterhaltung: 'cat_entertainment',
    steuer_versicherung: 'cat_taxes',
    geschaeftsessen: 'cat_expenses',
    restaurant_privat: 'cat_expenses',
    lebensmittel: 'cat_expenses',
    wohnen: 'cat_rent',
    gesundheit: 'cat_expenses',
    koerperpflege: 'cat_expenses',
    sonstiges: 'cat_other',
  }
  return byKey[category] || 'cat_expenses'
}

function buildDisplayName(input: {
  merchant: string | null
  transaction_date: string | null
  total_amount: number | null
  currency: string
}): string {
  const merchant = (input.merchant || 'Receipt').trim()
  const date = input.transaction_date || new Date().toISOString().slice(0, 10)
  const amount =
    input.total_amount != null && Number.isFinite(input.total_amount)
      ? `${input.total_amount.toFixed(2)} ${input.currency}`
      : input.currency
  return `${merchant} Receipt ${date} ${amount}`.trim().slice(0, 200)
}

async function mirrorToAnimaDrive(params: {
  supabase: ReturnType<typeof createClient>
  ownerId: string
  imageUrl: string
  receipt: Awaited<ReturnType<typeof extractReceipt>>
}) {
  const { supabase, ownerId, imageUrl, receipt } = params
  const fetched = await fetch(imageUrl)
  if (!fetched.ok) {
    throw new Error(`anima-drive mirror fetch failed: ${fetched.status}`)
  }
  const contentType = fetched.headers.get('content-type') || 'image/jpeg'
  const ext = extFromMime(contentType)
  const bytes = Buffer.from(await fetched.arrayBuffer())
  const documentId = crypto.randomUUID()
  const storagePath = `${ownerId}/${documentId}.${ext}`
  const nowIso = new Date().toISOString()
  const categoryKey = mapCfoToAdCategory(receipt.category)
  const displayName = buildDisplayName(receipt)

  const { error: storageErr } = await supabase.storage
    .from('ad-docs')
    .upload(storagePath, bytes, { contentType, upsert: true })
  if (storageErr) {
    throw new Error(`anima-drive storage upload failed: ${storageErr.message}`)
  }

  const { error: docErr } = await (supabase as any).from('ad_documents').insert({
    id: documentId,
    user_id: ownerId,
    filename: `${displayName}.${ext}`.slice(0, 255),
    display_name: displayName,
    ext,
    size_bytes: bytes.length,
    storage_path: storagePath,
    mime_type: contentType,
    category_key: categoryKey,
    category_confidence: receipt.category_confidence || 0.85,
    status: 'ready',
    categorized_at: nowIso,
    extracted_at: nowIso,
    error_message: receipt.extraction_status === 'failed' ? receipt.extraction_error : null,
  })
  if (docErr) {
    throw new Error(`anima-drive ad_documents insert failed: ${docErr.message}`)
  }

  const { error: exErr } = await (supabase as any).from('ad_extractions').insert({
    document_id: documentId,
    document_type: 'financial',
    summary:
      receipt.extraction_status === 'ok'
        ? `Receipt from ${receipt.merchant || 'unknown merchant'} on ${
            receipt.transaction_date || 'unknown date'
          } categorized as ${receipt.category}.`
        : 'Receipt extraction failed; uploaded for manual review.',
    metadata: {
      cfo_category: receipt.category,
      free_tags: receipt.free_tags,
      source: 'whatsanima',
    },
    vendor: receipt.merchant,
    doc_date: receipt.transaction_date,
    total_amount: receipt.total_amount,
    currency: receipt.currency || 'EUR',
    vat_amount: receipt.vat_amount,
    invoice_number: null,
    due_date: null,
    payment_terms: null,
    raw_extraction: receipt.raw_vision_response,
  })
  if (exErr) {
    throw new Error(`anima-drive ad_extractions insert failed: ${exErr.message}`)
  }

  await (supabase as any).from('ad_activities').insert([
    {
      user_id: ownerId,
      document_id: documentId,
      type: 'categorized',
      message: `Categorized ${displayName} as ${categoryKey}`,
      metadata: { source: 'whatsanima', cfo_category: receipt.category },
    },
    {
      user_id: ownerId,
      document_id: documentId,
      type: 'extracted',
      message: `Extracted financial document: ${displayName}`,
      metadata: { source: 'whatsanima', extraction_status: receipt.extraction_status },
    },
  ])

  return { documentId, categoryKey, storagePath }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const {
    conversationId,
    ownerId,
    contactId,
    imageUrl,
    userMessageId,
  }: {
    conversationId?: string
    ownerId?: string
    contactId?: string
    imageUrl?: string
    userMessageId?: string
  } = req.body ?? {}

  if (!ownerId || !contactId || !imageUrl) {
    return res.status(400).json({ error: 'ownerId, contactId and imageUrl are required' })
  }

  const allowedOwners = allowedOwnerIds()
  if (!allowedOwners.includes(ownerId)) {
    return res.status(200).json({
      ok: true,
      skipped: 'owner-not-allowed',
      ownerId,
      allowedOwners,
    })
  }

  const { client: supabase, missing } = getSupabaseAdmin()
  if (!supabase) {
    return res.status(503).json({ error: `DB not configured – missing ${missing}` })
  }

  try {
    if (userMessageId) {
      const { data: existingTx } = await supabase
        .from('cfo_transactions')
        .select('id')
        .eq('owner_id', ownerId)
        .eq('message_id', userMessageId)
        .limit(1)
        .maybeSingle()
      if (existingTx?.id) {
        return res.status(200).json({ ok: true, deduplicated: true })
      }
    }

    console.info('[cfo-receipt-ingest] start', {
      ownerId,
      contactId,
      conversationId: conversationId ?? null,
      userMessageId: userMessageId ?? null,
    })

    const extraction = await extractReceipt(imageUrl)

    let animaDriveMirror: { ok: boolean; documentId?: string; error?: string } = { ok: false }
    let mirroredStoragePath: string | null = null
    try {
      const mirrored = await mirrorToAnimaDrive({
        supabase,
        ownerId,
        imageUrl,
        receipt: extraction,
      })
      mirroredStoragePath = mirrored.storagePath
      animaDriveMirror = { ok: true, documentId: mirrored.documentId }
    } catch (mirrorErr: any) {
      animaDriveMirror = { ok: false, error: mirrorErr?.message || 'mirror failed' }
      console.warn('[cfo-receipt-ingest] anima-drive mirror failed:', animaDriveMirror.error)
    }

    const { error: insertError } = await supabase.from('cfo_transactions').insert({
      owner_id: ownerId,
      contact_id: contactId,
      conversation_id: conversationId ?? null,
      message_id: userMessageId ?? null,
      image_url: imageUrl,
      drive_url: mirroredStoragePath,
      sheets_row_index: null,
      ...extraction,
    })
    if (insertError) {
      throw new Error(insertError.message)
    }

    console.info('[cfo-receipt-ingest] stored transaction', {
      ownerId,
      contactId,
      conversationId: conversationId ?? null,
      drive_ok: animaDriveMirror.ok,
      mirroredStoragePath,
      extraction_status: extraction.extraction_status,
    })

    return res.status(200).json({
      ok: true,
      extraction_status: extraction.extraction_status,
      drive_ok: animaDriveMirror.ok,
      sheets_ok: true,
      anima_drive: animaDriveMirror,
    })
  } catch (error: any) {
    console.error('[cfo-receipt-ingest] Error:', error?.message || error)
    return res.status(500).json({ error: error?.message || 'Failed to ingest receipt' })
  }
}
