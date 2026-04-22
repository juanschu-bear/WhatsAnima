import { CFO_CATEGORY_KEYS, isCfoCategory, type CfoCategoryKey } from './cfoCategories.js'

export interface ExtractedReceipt {
  merchant: string | null
  transaction_date: string | null
  total_amount: number | null
  currency: string
  vat_amount: number | null
  category: CfoCategoryKey
  category_confidence: number
  free_tags: string[]
  line_items: unknown[]
  is_business_expense: boolean
  tax_relevant: boolean
  payment_method: string | null
  raw_vision_response: unknown
  extraction_status: 'ok' | 'failed'
  extraction_error: string | null
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

const SYSTEM_PROMPT =
  'You extract structured data from receipt images. Respond with STRICT JSON only — no markdown fences, no prose, no commentary.'

const USER_PROMPT = `Analyze this receipt image. Return STRICT JSON only, no markdown, no backticks. Fields:
merchant (string), transaction_date (YYYY-MM-DD), total_amount (number), currency (ISO code, default EUR), vat_amount (number or null), category (one of the 16 keys from the list below), category_confidence (0.0-1.0), free_tags (string array, empty unless category is sonstiges), line_items (array of {name, quantity, unit_price, total}), payment_method (string or null), is_business_expense (boolean guess), tax_relevant (boolean guess).

Categories: ${CFO_CATEGORY_KEYS.join(', ')}.
If sonstiges, add 1-3 free_tags. For all other categories, free_tags must be empty array.`

function failed(error: string, raw: unknown = null): ExtractedReceipt {
  return {
    merchant: null,
    transaction_date: null,
    total_amount: null,
    currency: 'EUR',
    vat_amount: null,
    category: 'sonstiges',
    category_confidence: 0,
    free_tags: [],
    line_items: [],
    is_business_expense: false,
    tax_relevant: false,
    payment_method: null,
    raw_vision_response: raw,
    extraction_status: 'failed',
    extraction_error: error,
  }
}

function stripJsonFence(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  return (fenceMatch ? fenceMatch[1] : text).trim()
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const num = typeof value === 'number' ? value : parseFloat(String(value))
  return Number.isFinite(num) ? num : null
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function normalizeCurrency(value: unknown): string {
  const s = toStringOrNull(value)
  if (!s) return 'EUR'
  const upper = s.toUpperCase()
  return /^[A-Z]{3}$/.test(upper) ? upper : 'EUR'
}

function normalizeDate(value: unknown): string | null {
  const s = toStringOrNull(value)
  if (!s) return null
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

function normalizeConfidence(value: unknown): number {
  const num = toNumberOrNull(value)
  if (num === null) return 0
  if (num < 0) return 0
  if (num > 1) return 1
  return Math.round(num * 100) / 100
}

function normalizeTags(value: unknown, category: CfoCategoryKey): string[] {
  if (category !== 'sonstiges') return []
  if (!Array.isArray(value)) return []
  const tags = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
  return tags.slice(0, 3)
}

function normalizeLineItems(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function coerceCategory(value: unknown): CfoCategoryKey {
  return isCfoCategory(value) ? value : 'sonstiges'
}

export async function extractReceipt(imageUrl: string): Promise<ExtractedReceipt> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return failed('OPENAI_API_KEY not configured')
  if (!imageUrl) return failed('imageUrl is required')

  const model = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini'
  const payload = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: USER_PROMPT },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
    max_tokens: 1024,
    temperature: 0,
    response_format: { type: 'json_object' },
  }

  let rawText = ''
  let response: Response
  try {
    response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    return failed(`network error: ${err instanceof Error ? err.message : String(err)}`)
  }

  const body = (await response.json().catch(() => null)) as
    | { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }
    | null

  if (!response.ok) {
    return failed(`openai error ${response.status}: ${body?.error?.message || 'unknown'}`, body)
  }

  rawText = body?.choices?.[0]?.message?.content ?? ''
  if (!rawText.trim()) return failed('empty model response', body)

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(stripJsonFence(rawText)) as Record<string, unknown>
  } catch (err) {
    return failed(`json parse error: ${err instanceof Error ? err.message : String(err)}`, rawText)
  }

  const category = coerceCategory(parsed.category)
  return {
    merchant: toStringOrNull(parsed.merchant),
    transaction_date: normalizeDate(parsed.transaction_date),
    total_amount: toNumberOrNull(parsed.total_amount),
    currency: normalizeCurrency(parsed.currency),
    vat_amount: toNumberOrNull(parsed.vat_amount),
    category,
    category_confidence: normalizeConfidence(parsed.category_confidence),
    free_tags: normalizeTags(parsed.free_tags, category),
    line_items: normalizeLineItems(parsed.line_items),
    is_business_expense: Boolean(parsed.is_business_expense),
    tax_relevant: Boolean(parsed.tax_relevant),
    payment_method: toStringOrNull(parsed.payment_method),
    raw_vision_response: parsed,
    extraction_status: 'ok',
    extraction_error: null,
  }
}
