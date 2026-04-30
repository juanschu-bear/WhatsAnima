import { createClient } from '@supabase/supabase-js'
import { extractReceipt } from './_lib/receiptExtraction.js'
import { appendReceiptToSheet, uploadReceiptToDrive, type ReceiptSheetRow } from './_lib/googleServices.js'

const JORDAN_CASH_OWNER_ID = '77ad10a6-1d73-4201-9e81-e6be996d130a'

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url) return { client: null, missing: 'SUPABASE_URL' }
  if (!key) return { client: null, missing: 'SUPABASE_SERVICE_ROLE_KEY' }
  return { client: createClient(url, key), missing: null }
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

  if (ownerId !== JORDAN_CASH_OWNER_ID) {
    return res.status(200).json({ ok: true, skipped: 'non-jordan-owner' })
  }

  const { client: supabase, missing } = getSupabaseAdmin()
  if (!supabase) {
    return res.status(503).json({ error: `DB not configured – missing ${missing}` })
  }

  try {
    const extraction = await extractReceipt(imageUrl)

    const [driveResult, sheetsResult] = await Promise.all([
      uploadReceiptToDrive(imageUrl, extraction),
      appendReceiptToSheet({
        transactionDate: extraction.transaction_date,
        merchant: extraction.merchant,
        totalAmount: extraction.total_amount,
        currency: extraction.currency,
        vatAmount: extraction.vat_amount,
        category: extraction.category,
        isBusinessExpense: extraction.is_business_expense,
        taxRelevant: extraction.tax_relevant,
        paymentMethod: extraction.payment_method,
        freeTags: extraction.free_tags,
        driveUrl: null,
        whatsanimaUrl: conversationId ? `https://whatsanima.com/chat/${conversationId}` : null,
      } satisfies ReceiptSheetRow),
    ])

    const { error: insertError } = await supabase.from('cfo_transactions').insert({
      owner_id: ownerId,
      contact_id: contactId,
      conversation_id: conversationId ?? null,
      message_id: userMessageId ?? null,
      image_url: imageUrl,
      drive_url: driveResult.url,
      sheets_row_index: sheetsResult.rowIndex,
      ...extraction,
    })
    if (insertError) {
      throw new Error(insertError.message)
    }

    return res.status(200).json({
      ok: true,
      extraction_status: extraction.extraction_status,
      drive_ok: Boolean(driveResult.url),
      sheets_ok: sheetsResult.rowIndex != null,
    })
  } catch (error: any) {
    console.error('[cfo-receipt-ingest] Error:', error?.message || error)
    return res.status(500).json({ error: error?.message || 'Failed to ingest receipt' })
  }
}

