import { Client } from 'pg'

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.'
const LANGUAGE_INSTRUCTION =
  'CRITICAL: Always respond in the same language the user\'s last message is written in. If they write Spanish, respond in Spanish. If German, German. If English, English. Never mix languages unless the user does. Never use em-dashes (—).'
const FORMATTING_INSTRUCTION =
  "IMPORTANT FORMATTING RULE: Respond conversationally as if you're texting. No bullet points, no bold text, no headers, no markdown formatting. No asterisks, no dashes for lists, no numbered lists. Write like you're actually talking to someone in a private chat. Keep it natural and direct."

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  image_url?: string
  isImage?: boolean
  isVideo?: boolean
  isVoice?: boolean
}

function getDatabaseUrl() {
  return (
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.SUPABASE_DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    ''
  )
}

async function loadOwnerPrompt(conversationId: string | undefined) {
  if (!conversationId) return DEFAULT_SYSTEM_PROMPT
  const databaseUrl = getDatabaseUrl()
  if (!databaseUrl) return DEFAULT_SYSTEM_PROMPT

  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } })
  try {
    await client.connect()
    const result = await client.query(
      `
        select o.system_prompt
        from public.wa_conversations c
        join public.wa_owners o on o.id = c.owner_id
        where c.id = $1
        limit 1
      `,
      [conversationId]
    )
    return result.rows[0]?.system_prompt?.trim() || DEFAULT_SYSTEM_PROMPT
  } finally {
    await client.end().catch(() => undefined)
  }
}

async function callAnthropic(apiKey: string, systemPrompt: string, messages: ChatMessage[]) {
  const payload = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    system: systemPrompt,
    messages: messages.map((message) => {
      if (message.image_url && message.role === 'user') {
        return {
          role: message.role,
          content: [
            { type: 'image', source: { type: 'url', url: message.image_url } },
            { type: 'text', text: message.content || 'The user shared this image.' },
          ],
        }
      }
      return { role: message.role, content: message.content }
    }),
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  })

  const result = await response.json()
  if (!response.ok) {
    throw new Error(result.error?.message || `Anthropic error ${response.status}`)
  }

  return result.content?.[0]?.text?.trim() || ''
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

  const {
    message,
    conversationId,
    history,
    image_url,
    isImage,
    isVideo,
    isVoice,
  }: {
    message?: string
    conversationId?: string
    history?: ChatMessage[]
    image_url?: string
    isImage?: boolean
    isVideo?: boolean
    isVoice?: boolean
  } = req.body ?? {}

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message content is required' })
  }

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
    const ownerPrompt = await loadOwnerPrompt(conversationId)
    const systemPrompt = `${ownerPrompt}\n\n${FORMATTING_INSTRUCTION}\n\n${LANGUAGE_INSTRUCTION}`
    const messages: ChatMessage[] = [
      ...priorMessages.slice(-30),
      {
        role: 'user',
        content: message.trim(),
        image_url,
        isImage,
        isVideo,
        isVoice,
      },
    ]

    const content = await callAnthropic(apiKey, systemPrompt, messages)
    if (!content) {
      return res.status(200).json({ content: 'Sorry, I could not generate a response.' })
    }

    return res.status(200).json({ content })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('Chat API error:', errorMessage, error)
    return res.status(500).json({
      error: errorMessage,
      content: `Sorry, something went wrong: ${errorMessage}`,
    })
  }
}
