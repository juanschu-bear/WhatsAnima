import { Client } from 'pg'

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.'
const LANGUAGE_INSTRUCTION =
  'CRITICAL: Always respond in the same language the user\'s last message is written in. If they write Spanish, respond in Spanish. If German, German. If English, English. Never mix languages unless the user does. Never use em-dashes (—).'
const SPANISH_DIALECT_INSTRUCTION =
  'SPANISH DIALECT: When responding in Spanish, use neutral Castellano as spoken in Ecuador or Colombia. NEVER use Mexican slang or expressions (no "la neta", "güey", "chido", "no mames", "se te atoró", "mero", "padre", "qué onda"). Use neutral Latin American expressions instead. Example: say "¿qué pasó?" not "¿qué onda?", say "en serio" not "la neta", say "genial" not "chido".'
const RESPONSE_FORMAT_MATCHING =
  `### Response Format Matching
- The system automatically determines whether to send your response as text or voice — you do NOT need to indicate the format.
- NEVER prefix your response with tags like [Voice Response], [Text], [Voice message], or any brackets. Just write your natural response.
- NEVER claim you are "text-only", that you "can only do text", or that you cannot send voice messages. You can. Your text output is automatically converted to audio when voice output is triggered.
- NEVER break character to explain technical limitations. You are not an AI assistant. You are you.
- Respond conversationally. Be natural, direct, no disclaimers.`
const FORMATTING_INSTRUCTION =
  "IMPORTANT FORMATTING RULE: Respond conversationally as if you're texting. No bullet points, no bold text, no headers, no markdown formatting. No asterisks, no dashes for lists, no numbered lists. Write like you're actually talking to someone in a private chat. Keep it natural and direct."
const MESSAGE_TYPE_AWARENESS =
  `### Message Type Awareness
- Each message in the conversation is tagged with its type: [TEXT], [VOICE], [VIDEO], or [IMAGE].
- [TEXT] means the user typed a text message. You CANNOT hear tone, pitch, volume, or any audio qualities in text messages. NEVER claim you can.
- [VOICE] means the user sent a voice message that was transcribed. You may have perception data about tone/emotion from the audio analysis system, but only reference what the perception context explicitly provides.
- [VIDEO] means the user sent a video message. You may have perception data from the video analysis.
- [IMAGE] means the user shared an image.
- CRITICAL: Never confuse message types. If the current message is [TEXT], do NOT reference audio qualities like volume, tone of voice, speaking speed, or intensity — those do not exist in text. If caught making claims about sensory data that doesn't exist for the message type, you lose credibility.
- When responding to a text message that references a previous voice/video message, clearly distinguish between what you observed in the earlier media and what is in the current text.`

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  image_url?: string
  isImage?: boolean
  isVideo?: boolean
  isVoice?: boolean
  msgType?: string
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

async function loadOwnerPromptAndMemory(conversationId: string | undefined): Promise<{ ownerPrompt: string; memory: string; stylePrompt: string }> {
  if (!conversationId) return { ownerPrompt: DEFAULT_SYSTEM_PROMPT, memory: '', stylePrompt: '' }
  const databaseUrl = getDatabaseUrl()
  if (!databaseUrl) return { ownerPrompt: DEFAULT_SYSTEM_PROMPT, memory: '', stylePrompt: '' }

  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } })
  try {
    await client.connect()
    const [ownerResult, memoryResult] = await Promise.all([
      client.query(
        `select o.system_prompt, o.is_self_avatar, o.communication_style from public.wa_conversations c join public.wa_owners o on o.id = c.owner_id where c.id = $1 limit 1`,
        [conversationId]
      ),
      client.query(
        `select summary, key_facts from public.wa_conversation_memory where conversation_id = $1 limit 1`,
        [conversationId]
      ).catch(() => ({ rows: [] })),
    ])

    const ownerRow = ownerResult.rows[0]
    const ownerPrompt = ownerRow?.system_prompt?.trim() || DEFAULT_SYSTEM_PROMPT

    // Build communication style injection (only for self-avatars)
    let stylePrompt = ''
    if (ownerRow?.is_self_avatar && ownerRow?.communication_style) {
      const style = ownerRow.communication_style
      const parts = ['[YOUR COMMUNICATION STYLE — this is how you naturally talk and think]']
      if (Array.isArray(style.traits) && style.traits.length > 0) {
        parts.push(`Personality: ${style.traits.join('; ')}`)
      }
      if (Array.isArray(style.speech_patterns) && style.speech_patterns.length > 0) {
        parts.push(`Speech patterns: ${style.speech_patterns.join('; ')}`)
      }
      if (Array.isArray(style.thinking_style) && style.thinking_style.length > 0) {
        parts.push(`Thinking style: ${style.thinking_style.join('; ')}`)
      }
      parts.push('Adopt these patterns naturally. This is who you ARE, not a persona you perform.')
      stylePrompt = '\n\n' + parts.join('\n')
    }

    let memory = ''
    const memRow = memoryResult.rows[0]
    if (memRow?.summary || (Array.isArray(memRow?.key_facts) && memRow.key_facts.length > 0)) {
      const facts: string[] = Array.isArray(memRow?.key_facts) ? memRow.key_facts : []
      const profileFacts = facts.filter((f: string) => !/^\[\d{4}-\d{2}/.test(f))
      const timelineEvents = facts.filter((f: string) => /^\[\d{4}-\d{2}/.test(f))

      const lines = ['[CONVERSATION MEMORY — things you remember about this user]']
      if (profileFacts.length > 0) {
        lines.push(`\nUser profile: ${profileFacts.join('; ')}`)
      }
      if (timelineEvents.length > 0) {
        lines.push(`\nTimeline: ${timelineEvents.join('; ')}`)
      }
      if (memRow.summary) {
        lines.push(`\nLast session: ${memRow.summary}`)
      }
      lines.push('\nUse this memory naturally. Reference past events, milestones, and user details when relevant. Never say "according to my memory" or "I remember" explicitly — just know these things like a close friend would.')
      memory = '\n\n' + lines.join('\n')
    }

    return { ownerPrompt, memory, stylePrompt }
  } finally {
    await client.end().catch(() => undefined)
  }
}

function getMessageTypeTag(msg: ChatMessage): string {
  if (msg.msgType === 'voice' || msg.isVoice) return '[VOICE] '
  if (msg.msgType === 'video' || msg.isVideo) return '[VIDEO] '
  if (msg.msgType === 'image' || msg.isImage) return '[IMAGE] '
  return '[TEXT] '
}

async function callAnthropic(apiKey: string, systemPrompt: string, messages: ChatMessage[]) {
  const payload = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 600,
    system: systemPrompt,
    messages: messages.map((message) => {
      const tag = message.role === 'user' ? getMessageTypeTag(message) : ''
      if (message.image_url && message.role === 'user') {
        return {
          role: message.role,
          content: [
            { type: 'image', source: { type: 'url', url: message.image_url } },
            { type: 'text', text: `${tag}${message.content || 'The user shared this image.'}` },
          ],
        }
      }
      return { role: message.role, content: tag ? `${tag}${message.content}` : message.content }
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
    const { ownerPrompt, memory, stylePrompt } = await loadOwnerPromptAndMemory(conversationId)
    const systemPrompt = `${ownerPrompt}\n\n${RESPONSE_FORMAT_MATCHING}\n\n${FORMATTING_INSTRUCTION}\n\n${MESSAGE_TYPE_AWARENESS}\n\n${LANGUAGE_INSTRUCTION}\n\n${SPANISH_DIALECT_INSTRUCTION}${stylePrompt}${memory}${buildPerceptionPrompt(perception)}`
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
