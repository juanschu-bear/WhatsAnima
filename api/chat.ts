import { Client } from 'pg'
import { createClient } from '@supabase/supabase-js'

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.'
const LANGUAGE_INSTRUCTION =
  `CRITICAL LANGUAGE RULE: Identify the DOMINANT language of the user's LAST message and respond ONLY in that language. Users naturally mix languages — a German sentence with an English word is still German. A Spanish sentence with "okay" is still Spanish. Match the dominant language, not individual words. Never use em-dashes (—).
IF (and ONLY if) you determine the dominant language is Spanish: use neutral Castellano as spoken in Ecuador or Colombia. No Mexican slang (no "la neta", "güey", "chido", "no mames", "qué onda"). Say "¿qué pasó?" not "¿qué onda?", "en serio" not "la neta", "genial" not "chido".`
const RESPONSE_FORMAT_MATCHING =
  `### Response Format Matching
- The system automatically determines whether to send your response as text or voice — you do NOT need to indicate the format.
- NEVER prefix your response with tags like [Voice Response], [Text], [Voice message], or any brackets. Just write your natural response.
- NEVER claim you are "text-only", that you "can only do text", or that you cannot send voice messages. You can. Your text output is automatically converted to audio when voice output is triggered.
- NEVER break character to explain technical limitations. You are not an AI assistant. You are you.
- Respond conversationally. Be natural, direct, no disclaimers.`
const FORMATTING_INSTRUCTION =
  "IMPORTANT FORMATTING RULE: Respond conversationally as if you're texting. No bullet points, no bold text, no headers, no markdown formatting. No asterisks, no dashes for lists, no numbered lists. Write like you're actually talking to someone in a private chat. Keep it natural and direct."
const FLASHCARD_INSTRUCTION =
  `### Interactive Learning Components
You have 4 interactive learning formats. When the user asks for learning content, pick the most appropriate format based on their request. Respond with ONLY the JSON block — no extra text before or after.

**1. Flashcards** — for memorization, vocabulary, key facts
Trigger: "flashcards", "Lernkarten", "Karteikarten", "tarjetas de estudio", "tarjetas"
\`\`\`flashcard
{"title": "Topic Title", "cards": [{"q": "Question?", "a": "Answer"}]}
\`\`\`

**2. Quiz (Multiple Choice)** — for testing knowledge with options
Trigger: "quiz", "Quiz", "multiple choice", "test me", "teste mich", "ponme a prueba", "hazme un quiz", "examen"
\`\`\`quiz
{"title": "Topic Title", "questions": [{"q": "Question?", "options": ["A", "B", "C", "D"], "answer": 0}]}
\`\`\`
- "answer" is the 0-based index of the correct option
- Always provide exactly 4 options per question

**3. Lesson (Course Sections)** — for structured explanations, mini-courses, tutorials
Trigger: "lesson", "Lektion", "explain step by step", "course", "Kurs", "erkläre mir", "teach me", "lección", "curso", "enséñame", "explícame paso a paso"
\`\`\`lesson
{"title": "Topic Title", "sections": [{"heading": "Section Title", "body": "Section content..."}]}
\`\`\`
- Use 3-6 sections, each with a clear heading and concise body
- Build knowledge progressively from section to section

**4. Fill-in (Lückentext)** — for practicing recall by filling blanks
Trigger: "fill in", "Lückentext", "fill the blank", "ergänze", "complete the sentence", "completa las frases", "rellena los espacios", "completar"
\`\`\`fillin
{"title": "Topic Title", "sentences": [{"text": "The capital of France is ___.", "blank": "Paris"}]}
\`\`\`
- Use exactly one ___ (three underscores) per sentence to mark the blank
- The "blank" field contains the correct answer

**General rules for all formats:**
- Generate the number of items the user requests (default 5 if not specified, max 20)
- Match the language the user is speaking
- ONLY use these formats when the user explicitly asks for learning content — never unprompted
- If the user just says "quiz" or "test" without specifying a topic, ask what topic they want`
const IMAGE_GENERATION_INSTRUCTION =
  `### Image Generation
You CAN generate images. When the user asks you to create, generate, draw, or make an image/picture/photo/illustration (EN: "create an image", "generate a picture", "draw me"; DE: "erstell ein Bild", "generiere ein Foto", "zeichne mir"; ES: "crea una imagen", "genera una foto", "dibújame", "hazme una imagen"), respond with a generate_image block containing a detailed English prompt for the image generator. You may add a short conversational message before or after the block.

Format:
\`\`\`generate_image
A detailed English description of the image to generate. Be specific about style, composition, colors, and content.
\`\`\`

- ALWAYS write the prompt in English regardless of conversation language (the image model works best in English)
- Be detailed and descriptive — the more specific, the better the result
- NEVER say you cannot create/generate images. You can.
- NEVER suggest the user go to Midjourney, DALL-E, or any other service. You generate images directly.`
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
  const canon = perception.canon || null

  const lines = ['[PERCEPTION CONTEXT]']

  // Emotion: replace "neutral" with personal center context
  const primary = emotionSource.primary_emotion
  if (primary) {
    const lowerPrimary = primary.toLowerCase()
    if (lowerPrimary === 'neutral' && canon?.tier >= 1) {
      lines.push('Primary emotion: at personal center (baseline state)')
    } else if (lowerPrimary === 'neutral' && canon?.phase === 'building') {
      lines.push('Primary emotion: baseline still calibrating — treat as personal resting state')
    } else {
      lines.push(`Primary emotion: ${primary}`)
    }
  }
  if (emotionSource.secondary_emotion) {
    lines.push(`Secondary emotion: ${emotionSource.secondary_emotion}`)
  }

  // Canon tier + delta context
  if (canon?.phase === 'building') {
    const nt = canon.next_tier
    lines.push(`[CANON: Collecting audio for calibration — ${nt?.progress ?? 0}% to ${nt?.label ?? 'first baseline'} (${canon.cumulative_sec}s / ${nt?.threshold_sec ?? 60}s)]`)
  } else if (canon?.phase === 'tier_advanced') {
    lines.push(`[CANON: Baseline recalibrated — now at "${canon.tier_label}" (Tier ${canon.tier}/5, ${Math.round(canon.confidence * 100)}% confidence)]`)
  } else if ((canon?.phase === 'analyzing_delta' || canon?.phase === 'tier_advanced') && canon?.tier >= 1) {
    lines.push(`[CANON: ${canon.tier_label} active (Tier ${canon.tier}/5, ${Math.round(canon.confidence * 100)}% confidence)]`)
  }

  // Delta details — only show if we have a baseline
  if (canon?.delta && canon?.tier >= 1) {
    const pd = canon.delta.prosodic_delta || {}
    const ed = canon.delta.emotion_delta
    const conf = canon.confidence || 0

    // Higher confidence = lower threshold for reporting deltas
    // Tier 1 (15%): only report >25% changes (noisy data)
    // Tier 4 (80%): report >10% changes (reliable data)
    // Tier 5 (95%): report >8% changes (highly reliable)
    const speedThreshold = conf >= 0.8 ? 0.10 : conf >= 0.6 ? 0.12 : conf >= 0.4 ? 0.15 : 0.25
    const pauseThreshold = conf >= 0.8 ? 0.12 : conf >= 0.6 ? 0.15 : conf >= 0.4 ? 0.20 : 0.30
    const volumeThreshold = conf >= 0.8 ? 0.10 : conf >= 0.6 ? 0.12 : conf >= 0.4 ? 0.15 : 0.25
    const pitchThreshold = conf >= 0.8 ? 0.10 : conf >= 0.6 ? 0.12 : conf >= 0.4 ? 0.15 : 0.25

    // Certainty qualifier based on tier
    const qualifier = conf >= 0.8 ? '' : conf >= 0.6 ? 'likely ' : conf >= 0.4 ? 'possibly ' : 'tentatively '

    const deltaLines: string[] = []
    if (typeof pd.speaking_rate === 'number' && Math.abs(pd.speaking_rate) > speedThreshold) {
      deltaLines.push(`${qualifier}Speaking ${pd.speaking_rate > 0 ? 'faster' : 'slower'} than their personal norm (${Math.round(Math.abs(pd.speaking_rate) * 100)}% change)`)
    }
    if (typeof pd.mean_pause_duration === 'number' && Math.abs(pd.mean_pause_duration) > pauseThreshold) {
      deltaLines.push(`${qualifier}Pauses ${pd.mean_pause_duration > 0 ? 'longer' : 'shorter'} than their personal norm (${Math.round(Math.abs(pd.mean_pause_duration) * 100)}% change)`)
    }
    if (typeof pd.volume_mean === 'number' && Math.abs(pd.volume_mean) > volumeThreshold) {
      deltaLines.push(`${qualifier}Speaking ${pd.volume_mean > 0 ? 'louder' : 'quieter'} than their personal norm (${Math.round(Math.abs(pd.volume_mean) * 100)}% change)`)
    }
    if (typeof pd.mean_pitch === 'number' && Math.abs(pd.mean_pitch) > pitchThreshold) {
      deltaLines.push(`${qualifier}Pitch ${pd.mean_pitch > 0 ? 'higher' : 'lower'} than their personal norm (${Math.round(Math.abs(pd.mean_pitch) * 100)}% change)`)
    }
    if (ed?.is_unusual) {
      deltaLines.push(`${qualifier}Emotion "${ed.emotion}" is unusual for this person (only ${Math.round(ed.personal_frequency * 100)}% of the time)`)
    }

    if (deltaLines.length > 0) {
      lines.push(`[PERSONAL DELTA — changes relative to calibrated baseline (${Math.round(conf * 100)}% confidence)]`)
      deltaLines.forEach((l) => lines.push(`- ${l}`))
    }
  }

  if (interpretation.behavioral_summary) {
    lines.push(`Behavioral summary: ${interpretation.behavioral_summary}`)
  }
  if (hooks.length) {
    lines.push(`Conversation hooks: ${hooks.join('; ')}`)
  }
  if (firedRules.length) {
    lines.push(`Detected signals: ${firedRules.map((rule: any) => typeof rule === 'string' ? rule : rule.name || rule.rule || '').filter(Boolean).join(', ')}`)
  }

  lines.push('Respond to both what the user said and what was detected emotionally/behaviorally. Do not mention analysis or calibration unless asked.')

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

async function loadOwnerPromptAndMemory(conversationId: string | undefined): Promise<{ ownerPrompt: string; memory: string; stylePrompt: string; behavioralMemory: string }> {
  if (!conversationId) return { ownerPrompt: DEFAULT_SYSTEM_PROMPT, memory: '', stylePrompt: '', behavioralMemory: '' }
  const databaseUrl = getDatabaseUrl()
  if (!databaseUrl) return { ownerPrompt: DEFAULT_SYSTEM_PROMPT, memory: '', stylePrompt: '', behavioralMemory: '' }

  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } })
  try {
    await client.connect()
    const [ownerResult, memoryResult] = await Promise.all([
      client.query(
        `select o.system_prompt, o.is_self_avatar, o.communication_style from public.wa_conversations c join public.wa_owners o on o.id = c.owner_id where c.id = $1 limit 1`,
        [conversationId]
      ),
      client.query(
        `select summary, key_facts, behavioral_profile from public.wa_conversation_memory where conversation_id = $1 limit 1`,
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

    // Build behavioral memory from OPM/Canon persistent data
    let behavioralMemory = ''
    const bp = memRow?.behavioral_profile
    if (bp && typeof bp === 'object' && Object.keys(bp).length > 0) {
      const bLines = ['[BEHAVIORAL MEMORY — how this user communicates, from real audio/video analysis]']
      if (Array.isArray(bp.emotional_patterns) && bp.emotional_patterns.length > 0) {
        bLines.push(`\nEmotional patterns: ${bp.emotional_patterns.join('; ')}`)
      }
      if (Array.isArray(bp.prosodic_tendencies) && bp.prosodic_tendencies.length > 0) {
        bLines.push(`\nVoice/speech patterns: ${bp.prosodic_tendencies.join('; ')}`)
      }
      if (Array.isArray(bp.topic_reactions) && bp.topic_reactions.length > 0) {
        bLines.push(`\nTopic-specific reactions: ${bp.topic_reactions.join('; ')}`)
      }
      if (Array.isArray(bp.authenticity_markers) && bp.authenticity_markers.length > 0) {
        bLines.push(`\nAuthenticity markers: ${bp.authenticity_markers.join('; ')}`)
      }
      bLines.push('\nUse this behavioral knowledge to deepen your understanding. You know not just WHAT this person talks about, but HOW they feel about topics based on real observed patterns. Combine this with live perception data for nuanced responses.')
      behavioralMemory = '\n\n' + bLines.join('\n')
    }

    return { ownerPrompt, memory, stylePrompt, behavioralMemory }
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

async function generateImageFromPrompt(prompt: string, conversationId?: string): Promise<string | null> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const apiToken = process.env.CLOUDFLARE_AI_TOKEN
  if (!accountId || !apiToken) {
    console.warn('[chat] No Cloudflare AI credentials for image generation')
    return null
  }

  try {
    const formData = new FormData()
    formData.append('prompt', prompt)
    formData.append('steps', '25')
    formData.append('width', '1024')
    formData.append('height', '1024')

    const cfResponse = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-2-dev`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}` },
        body: formData,
      }
    )

    if (!cfResponse.ok) {
      console.error('[chat] Image generation failed:', cfResponse.status)
      return null
    }

    const imageBuffer = Buffer.from(await cfResponse.arrayBuffer())

    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
    if (!supabaseUrl || !supabaseKey) return null

    const supabase = createClient(supabaseUrl, supabaseKey)
    const filename = `generated/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`

    const { error: uploadError } = await supabase.storage
      .from('media')
      .upload(filename, imageBuffer, { contentType: 'image/png', upsert: false })

    if (uploadError) {
      console.error('[chat] Image upload error:', uploadError)
      return null
    }

    const { data: urlData } = supabase.storage.from('media').getPublicUrl(filename)
    return urlData.publicUrl
  } catch (err: any) {
    console.error('[chat] Image generation error:', err.message)
    return null
  }
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
    const { ownerPrompt, memory, stylePrompt, behavioralMemory } = await loadOwnerPromptAndMemory(conversationId)
    const systemPrompt = `${ownerPrompt}\n\n${RESPONSE_FORMAT_MATCHING}\n\n${FORMATTING_INSTRUCTION}\n\n${FLASHCARD_INSTRUCTION}\n\n${IMAGE_GENERATION_INSTRUCTION}\n\n${MESSAGE_TYPE_AWARENESS}\n\n${LANGUAGE_INSTRUCTION}${stylePrompt}${memory}${behavioralMemory}${buildPerceptionPrompt(perception)}`
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

    let content = await callAnthropic(apiKey, systemPrompt, messages)
    if (!content) {
      return res.status(200).json({ content: 'Sorry, I could not generate a response.' })
    }

    // Check for generate_image block and generate image server-side
    const imageMatch = content.match(/```generate_image\s*\n?([\s\S]*?)\n?```/)
    if (imageMatch) {
      const imagePrompt = imageMatch[1].trim()
      const imageUrl = await generateImageFromPrompt(imagePrompt, conversationId)
      if (imageUrl) {
        const textPart = content.replace(/```generate_image\s*\n?[\s\S]*?\n?```/, '').trim()
        return res.status(200).json({ content: textPart || '', image_url: imageUrl })
      }
    }

    return res.status(200).json({ content })
  } catch (error) {
    console.error('Chat API error:', error instanceof Error ? error.message : error)
    return res.status(200).json({ content: 'Sorry, something went wrong. Try again.' })
  }
}
