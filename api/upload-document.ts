import crypto from 'node:crypto'
import pdfParse from 'pdf-parse'
import { createClient } from '@supabase/supabase-js'

export const config = {
  api: { bodyParser: { sizeLimit: '60mb' } },
}

function getSupabaseAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const supabaseKey =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY

  if (!supabaseUrl || !supabaseKey) return null
  return createClient(supabaseUrl, supabaseKey)
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\u0000/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function splitIntoChunks(text: string, maxChars = 1500): string[] {
  const normalized = normalizeWhitespace(text)
  if (!normalized) return []
  const paragraphs = normalized.split(/\n{2,}/g).map((item) => item.trim()).filter(Boolean)
  const chunks: string[] = []
  let current = ''

  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph
      continue
    }
    if ((current.length + 2 + paragraph.length) <= maxChars) {
      current = `${current}\n\n${paragraph}`
    } else {
      chunks.push(current)
      current = paragraph
    }
  }

  if (current) chunks.push(current)
  return chunks.slice(0, 200)
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const supabase = getSupabaseAdminClient()
  if (!supabase) {
    return res.status(503).json({ error: 'Storage not configured' })
  }

  const body = req.body ?? {}
  const mediaData = body.media || body.media_base64 || body.file
  const conversationId = String(body.conversationId || body.conversation_id || '').trim()
  const ownerId = String(body.ownerId || body.owner_id || '').trim()
  const fileNameInput = String(body.fileName || body.filename || 'shared-document.pdf').trim()
  const mimeType = String(body.mime_type || body.mimeType || 'application/pdf').trim().toLowerCase()
  const uploaderUserId = String(body.uploaderUserId || '').trim() || null

  if (!mediaData || !conversationId || !ownerId) {
    return res.status(400).json({ error: 'media, conversationId, and ownerId are required' })
  }
  if (mimeType !== 'application/pdf') {
    return res.status(400).json({ error: 'Only PDF uploads are currently supported' })
  }

  try {
    const buffer = Buffer.from(String(mediaData), 'base64')
    if (!buffer.length) {
      return res.status(400).json({ error: 'Empty PDF payload' })
    }
    if (buffer.length > 25 * 1024 * 1024) {
      return res.status(400).json({ error: 'PDF exceeds 25MB limit' })
    }

    await supabase.storage.createBucket('document-uploads', {
      public: true,
      fileSizeLimit: 25 * 1024 * 1024,
    }).catch(() => undefined)

    const safeName = fileNameInput.endsWith('.pdf') ? fileNameInput : `${fileNameInput}.pdf`
    const key = `${ownerId}/${conversationId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safeName}`
    const { error: uploadError } = await supabase.storage
      .from('document-uploads')
      .upload(key, buffer, { contentType: 'application/pdf', upsert: false })
    if (uploadError) {
      return res.status(500).json({ error: uploadError.message || 'Failed to upload PDF' })
    }

    const { data: urlData } = supabase.storage.from('document-uploads').getPublicUrl(key)
    const fileUrl = urlData.publicUrl

    let extractedText = ''
    let pageCount = 0
    let extractionStatus: 'ready' | 'failed' = 'ready'
    let extractionError: string | null = null

    try {
      const parsed = await pdfParse(buffer)
      extractedText = normalizeWhitespace(String(parsed.text || ''))
      pageCount = Number(parsed.numpages || 0)
    } catch (parseError: any) {
      extractionStatus = 'failed'
      extractionError = parseError?.message || 'pdf_parse_failed'
    }

    const { data: docRow, error: docError } = await supabase
      .from('wa_documents')
      .insert({
        conversation_id: conversationId,
        owner_id: ownerId,
        uploader_user_id: uploaderUserId,
        file_name: safeName,
        file_url: fileUrl,
        mime_type: 'application/pdf',
        byte_size: buffer.length,
        page_count: pageCount || null,
        extracted_text: extractedText || null,
        extraction_status: extractionStatus,
        extraction_error: extractionError,
      })
      .select('*')
      .single()
    if (docError || !docRow) {
      return res.status(500).json({ error: docError?.message || 'Failed to persist document metadata' })
    }

    if (extractionStatus === 'ready' && extractedText) {
      const chunks = splitIntoChunks(extractedText)
      if (chunks.length > 0) {
        const rows = chunks.map((content, index) => ({
          document_id: docRow.id,
          conversation_id: conversationId,
          owner_id: ownerId,
          chunk_index: index,
          content,
          token_estimate: Math.ceil(content.length / 4),
        }))
        await supabase.from('wa_document_chunks').insert(rows)
      }
    }

    return res.status(200).json({
      document: {
        id: docRow.id,
        file_name: docRow.file_name,
        file_url: fileUrl,
        page_count: docRow.page_count,
        extraction_status: docRow.extraction_status,
      },
    })
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'PDF upload failed' })
  }
}
