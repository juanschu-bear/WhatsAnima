import { Client } from 'pg'

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.'
const LANGUAGE_INSTRUCTION =
  'CRITICAL: Always respond in the same language the user\'s last message is written in. If they write Spanish, respond in Spanish. If German, German. If English, English. Never mix languages unless the user does. Never use em-dashes (—).'
const RESPONSE_FORMAT_MATCHING =
  `### Response Format Matching
- The system automatically determines whether to send your response as text or voice — you do NOT need to indicate the format.
- NEVER prefix your response with tags like [Voice Response], [Text], [Voice message], or any brackets. Just write your natural response.
- NEVER claim you are "text-only", that you "can only do text", or that you cannot send voice messages. You can. Your text output is automatically converted to audio when voice output is triggered.
- NEVER break character to explain technical limitations. You are not an AI assistant. You are you.
- Respond conversationally. Be natural, direct, no disclaimers.`
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

function buildPerceptionPrompt(perception: any) {
  if (!perception) return ''

  const emotionSource = perception.perception || perception
  const interpretation = perception.interpretation || {}
  const hooks = interpretation.conversation_hooks || emotionSource.session_patterns || []
  const firedRules = perception.fired_rules || []
  const lines = [
    '[PERCEPTION CONTEXT]',
    emotionSource.primary_emotion ? `Primary emotion: ${emotionSource.primary_emotion}` : null,
    emotionSource.secondary_emotion ? `Secondary emotion: ${emotionSource.secondary_emotion}` : null,
    interpretation.behavioral_summary ? `Behavioral summary: ${interpretation.behavioral_summary}` : null,
    hooks.length ? `Conversation hooks: ${hooks.join('; ')}` : null,
    firedRules.length ? `Detected signals: ${firedRules.map((rule: any) => typeof rule === 'string' ? rule : rule.name || rule.rule || '').filter(Boolean).join(', ')}` : null,
    'Respond to both what the user said and what was detected emotionally/behaviorally. Do not mention analysis unless asked.',
  ].filter(Boolean)

  return lines.length > 1 ? `\n\n${lines.join('\n')}` : ''
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

async function loadOwnerPromptAndMemory(conversationId: string | undefined): Promise<{ ownerPrompt: string; memory: string }> {
  if (!conversationId) return { ownerPrompt: DEFAULT_SYSTEM_PROMPT, memory: '' }
  const databaseUrl = getDatabaseUrl()
  if (!databaseUrl) return { ownerPrompt: DEFAULT_SYSTEM_PROMPT, memory: '' }

  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } })
  try {
    await client.connect()
    const [ownerResult, memoryResult] = await Promise.all([
      client.query(
        `select o.system_prompt from public.wa_conversations c join public.wa_owners o on o.id = c.owner_id where c.id = $1 limit 1`,
        [conversationId]
      ),
      client.query(
        `select summary, key_facts from public.wa_conversation_memory where conversation_id = $1 limit 1`,
        [conversationId]
      ).catch(() => ({ rows: [] })),
    ])

    const ownerPrompt = ownerResult.rows[0]?.system_prompt?.trim() || DEFAULT_SYSTEM_PROMPT

    let memory = ''
    const memRow = memoryResult.rows[0]
    if (memRow?.summary || (Array.isArray(memRow?.key_facts) && memRow.key_facts.length > 0)) {
      const lines = ['[CONVERSATION MEMORY — things you remember about this user from previous sessions]']
      if (memRow.summary) lines.push(`Summary: ${memRow.summary}`)
      if (Array.isArray(memRow.key_facts) && memRow.key_facts.length > 0) {
        lines.push(`Key facts: ${memRow.key_facts.join('; ')}`)
      }
      lines.push('Use this memory naturally in conversation. Reference past topics when relevant. Never say "according to my memory" — just know these things like a real person would.')
      memory = '\n\n' + lines.join('\n')
    }

    return { ownerPrompt, memory }
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

  let text = result.content?.[0]?.text?.trim() || ''
  // Strip any [Voice Response], [Voice message], [Text], etc. prefixes the LLM may add
  text = text.replace(/^\[(?:Voice\s*(?:Response|message)|Text|Audio)\]\s*/i, '')
  return text
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
    perception,
  }: {
    message?: string
    conversationId?: string
    history?: ChatMessage[]
    image_url?: string
    isImage?: boolean
    isVideo?: boolean
    isVoice?: boolean
    perception?: any
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
    const { ownerPrompt, memory } = await loadOwnerPromptAndMemory(conversationId)
    const systemPrompt = `${ownerPrompt}\n\n${RESPONSE_FORMAT_MATCHING}\n\n${FORMATTING_INSTRUCTION}\n\n${LANGUAGE_INSTRUCTION}${memory}${buildPerceptionPrompt(perception)}`
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
    console.error('Chat API error:', error instanceof Error ? error.message : error)
    return res.status(200).json({ content: 'Sorry, something went wrong. Try again.' })
  }
}
