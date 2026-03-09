import Anthropic from '@anthropic-ai/sdk'

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.'

const LANGUAGE_INSTRUCTION =
  'CRITICAL: Always respond in the same language the user\'s last message is written in. If they write Spanish, respond in Spanish. If German, German. If English, English. Never mix languages unless the user does. Never use em-dashes (\u2014).'

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(200).json({ content: 'Hey. Tell me something interesting.' })
  }

  const {
    message,
    systemPrompt,
    history,
  }: {
    message?: string
    systemPrompt?: string | null
    history?: ChatMessage[]
  } = req.body ?? {}

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Missing message' })
  }

  const safeSystemPrompt =
    typeof systemPrompt === 'string' && systemPrompt.trim().length > 0
      ? systemPrompt
      : DEFAULT_SYSTEM_PROMPT

  const priorMessages = Array.isArray(history)
    ? history.filter(
        (entry): entry is ChatMessage =>
          Boolean(entry) &&
          (entry.role === 'user' || entry.role === 'assistant') &&
          typeof entry.content === 'string' &&
          entry.content.trim().length > 0
      )
    : []

  const messages: ChatMessage[] = [
    ...priorMessages.slice(-10),
    { role: 'user', content: message },
  ]

  try {
    const client = new Anthropic({ apiKey })

    const response = await client.messages.create({
      model: 'claude-opus-4-5-20251101',
      max_tokens: 300,
      temperature: 0.5,
      system: `${safeSystemPrompt}\n\n${LANGUAGE_INSTRUCTION}`,
      messages,
    })

    const content =
      response.content[0]?.type === 'text'
        ? response.content[0].text.trim()
        : ''

    if (!content) {
      return res.status(200).json({ content: 'Sorry, I could not generate a response.' })
    }

    return res.status(200).json({ content })
  } catch (error) {
    console.error('Chat API error:', error instanceof Error ? error.message : error)
    return res.status(200).json({ content: 'Sorry, something went wrong. Try again.' })
  }
}
