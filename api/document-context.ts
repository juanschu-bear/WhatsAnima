import { createClient } from '@supabase/supabase-js'

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3)
}

function scoreChunk(queryTokens: Set<string>, content: string): number {
  if (queryTokens.size === 0) return 0
  const chunkTokens = tokenize(content)
  let score = 0
  for (const token of chunkTokens) {
    if (queryTokens.has(token)) score += 1
  }
  return score
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const supabase = getSupabaseAdmin()
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' })
  }

  try {
    const body = req.body ?? {}
    const conversationId = String(body.conversationId || '').trim()
    const query = String(body.query || '').trim()
    const maxChunks = Math.max(1, Math.min(8, Number(body.maxChunks || 4)))
    const explicitDocIds = Array.isArray(body.documentIds)
      ? body.documentIds.map((id: unknown) => String(id || '').trim()).filter(Boolean)
      : []

    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId is required' })
    }

    let documentIds = explicitDocIds
    if (documentIds.length === 0) {
      const { data: docs } = await supabase
        .from('wa_documents')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('extraction_status', 'ready')
        .order('created_at', { ascending: false })
        .limit(5)
      documentIds = (docs ?? []).map((row: any) => String(row.id || '').trim()).filter(Boolean)
    }

    if (documentIds.length === 0) {
      return res.status(200).json({ snippets: [] })
    }

    const { data: chunks, error: chunkError } = await supabase
      .from('wa_document_chunks')
      .select('document_id, chunk_index, content')
      .in('document_id', documentIds)
      .order('created_at', { ascending: false })
      .limit(400)
    if (chunkError) {
      return res.status(500).json({ error: chunkError.message || 'Failed to read chunks' })
    }

    const queryTokens = new Set(tokenize(query))
    const ranked = (chunks ?? [])
      .map((chunk: any) => ({
        ...chunk,
        score: scoreChunk(queryTokens, String(chunk.content || '')),
      }))
      .sort((a: any, b: any) => {
        if (b.score !== a.score) return b.score - a.score
        return Number(a.chunk_index || 0) - Number(b.chunk_index || 0)
      })
      .slice(0, maxChunks)

    const { data: docs } = await supabase
      .from('wa_documents')
      .select('id, file_name, file_url')
      .in('id', documentIds)

    const docById = new Map<string, { file_name: string; file_url: string }>()
    for (const row of docs ?? []) {
      docById.set(String(row.id), {
        file_name: String(row.file_name || 'Document'),
        file_url: String(row.file_url || ''),
      })
    }

    const snippets = ranked.map((chunk: any) => ({
      documentId: chunk.document_id,
      fileName: docById.get(String(chunk.document_id))?.file_name || 'Document',
      fileUrl: docById.get(String(chunk.document_id))?.file_url || '',
      chunkIndex: chunk.chunk_index,
      content: String(chunk.content || ''),
      score: chunk.score,
    }))

    return res.status(200).json({ snippets })
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to build document context' })
  }
}
