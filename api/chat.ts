const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.'

type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

function detectLanguage(text: string) {
  const lower = text.toLowerCase()
  if (/[¿¡]|ñ|á|é|í|ó|ú/.test(lower) || /\b(hola|que|cómo|gracias|vale|claro|bien)\b/.test(lower)) {
    return 'es'
  }
  if (/\b(hey|hallo|danke|genau|und|nicht|was|wie|gut|alter)\b/.test(lower)) {
    return 'de'
  }
  return 'en'
}

function fallbackReply(message: string) {
  const trimmed = message.trim()
  const language = detectLanguage(trimmed)

  if (language === 'de') {
    if (/^\s*(hey|hi|hallo)\s*[!.?]*$/i.test(trimmed)) return 'Hey, was geht? Was führt dich her?'
    return 'Honestly? Erzähl mir den interessanten Teil zuerst.'
  }
  if (language === 'es') {
    if (/^\s*(hey|hola|buenas)\s*[!.?]*$/i.test(trimmed)) return 'Hey. Que te trae por aqui?'
    return 'Honestamente? Dame la parte interesante primero.'
  }
  if (/^\s*(hey|hi|hello)\s*[!.?]*$/i.test(trimmed)) return 'Hey. Tell me something interesting.'
  return 'Honestly? Give me the interesting part first.'
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey =
    process.env.OPENAI_API_KEY ||
    process.env.OPENAI_KEY ||
    process.env.OPENAI_SECRET_KEY

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

  if (!apiKey) {
    return res.status(200).json({ content: fallbackReply(message) })
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_CHAT_MODEL || 'gpt-4.1-mini',
        temperature: 0.8,
        max_tokens: 180,
        messages: [
          { role: 'system', content: safeSystemPrompt },
          ...priorMessages.slice(-10),
          { role: 'user', content: message },
        ],
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      return res.status(200).json({ content: fallbackReply(message), details: errorText })
    }

    const data = await response.json()
    const content = data?.choices?.[0]?.message?.content?.trim()

    if (!content) {
      return res.status(200).json({ content: fallbackReply(message) })
    }

    return res.status(200).json({ content })
  } catch (error) {
    return res.status(200).json({
      content: fallbackReply(message),
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}
