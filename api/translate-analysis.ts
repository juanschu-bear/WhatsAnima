type TranslateRequestBody = {
  targetLocale?: 'es' | 'de'
  texts?: string[]
}

function extractText(result: any): string {
  if (!result || !Array.isArray(result.content)) return ''
  return result.content
    .filter((block: any) => block?.type === 'text' && typeof block?.text === 'string')
    .map((block: any) => block.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

function parseTranslations(raw: string, expected: number): string[] | null {
  if (!raw) return null
  const candidate = raw.trim()
  const tryParse = (text: string): string[] | null => {
    try {
      const parsed = JSON.parse(text) as { translations?: unknown }
      if (!Array.isArray(parsed.translations)) return null
      const items = parsed.translations.map((item) => (typeof item === 'string' ? item : String(item ?? '')))
      if (items.length !== expected) return null
      return items
    } catch {
      return null
    }
  }

  const direct = tryParse(candidate)
  if (direct) return direct
  const jsonMatch = candidate.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  return tryParse(jsonMatch[0])
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const body = (req.body ?? {}) as TranslateRequestBody
  const targetLocale = body.targetLocale === 'de' ? 'de' : body.targetLocale === 'es' ? 'es' : null
  const inputTexts = Array.isArray(body.texts) ? body.texts.map((text) => String(text ?? '')).slice(0, 60) : []

  if (!targetLocale || inputTexts.length === 0) {
    return res.status(200).json({ translations: inputTexts })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(200).json({ translations: inputTexts })
  }

  const sanitized = inputTexts.map((text) => text.trim()).map((text) => (text.length > 2500 ? `${text.slice(0, 2500)}...` : text))
  const languageLabel = targetLocale === 'es' ? 'Spanish' : 'German'

  try {
    const payload = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      temperature: 0,
      system: `You are a precise translator. Translate each text to ${languageLabel}.
Keep meaning, tone, and brevity.
Do not add explanations.
Return strict JSON only with this shape:
{"translations":["..."]}`,
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            targetLocale,
            texts: sanitized,
          }),
        },
      ],
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
      console.error('[translate-analysis] anthropic error', response.status, result)
      return res.status(200).json({ translations: inputTexts })
    }

    const rawText = extractText(result)
    const translations = parseTranslations(rawText, sanitized.length)
    if (!translations) {
      console.warn('[translate-analysis] unable to parse translation JSON')
      return res.status(200).json({ translations: inputTexts })
    }

    return res.status(200).json({ translations })
  } catch (error) {
    console.error('[translate-analysis] unexpected error', error)
    return res.status(200).json({ translations: inputTexts })
  }
}
