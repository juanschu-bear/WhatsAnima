import { createClient } from '@supabase/supabase-js'

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY
  if (!url) return { client: null, missing: 'SUPABASE_URL' }
  if (!key) return { client: null, missing: 'SUPABASE_SERVICE_KEY' }
  return { client: createClient(url, key), missing: null }
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

  const { client: supabase, missing } = getSupabaseAdmin()
  if (!supabase) {
    return res.status(503).json({ error: `DB not configured – missing ${missing}` })
  }

  const { conversationId, recentMessages } = req.body ?? {}
  if (!conversationId || !Array.isArray(recentMessages)) {
    return res.status(400).json({ error: 'conversationId and recentMessages are required' })
  }

  try {
    // Load existing memory
    const { data: existing } = await supabase
      .from('wa_conversation_memory')
      .select('summary, key_facts')
      .eq('conversation_id', conversationId)
      .maybeSingle()

    const existingSummary = existing?.summary || ''
    const existingFacts = existing?.key_facts || []

    // Build the conversation excerpt for the LLM
    const conversationExcerpt = recentMessages
      .map((m: any) => `${m.role === 'user' ? 'User' : 'Avatar'}: ${m.content}`)
      .join('\n')

    const prompt = `You are a memory extraction system. Given a conversation excerpt and existing memory, produce an updated memory summary.

EXISTING MEMORY:
${existingSummary || '(none yet)'}

EXISTING KEY FACTS:
${Array.isArray(existingFacts) && existingFacts.length > 0 ? existingFacts.join('\n') : '(none yet)'}

RECENT CONVERSATION:
${conversationExcerpt}

INSTRUCTIONS:
1. Write a concise updated summary (2-4 sentences) capturing the most important context about this user and conversation.
2. Extract key facts as a JSON array of short strings. Include: user's name, interests, goals, preferences, recurring topics, important dates or events they mentioned, emotional patterns, and anything the avatar should remember next time.
3. Merge with existing facts — don't duplicate, update if changed.

Respond in EXACTLY this JSON format:
{"summary": "...", "key_facts": ["fact 1", "fact 2", ...]}`

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    const result = await response.json()
    if (!response.ok) {
      console.error('[update-memory] Anthropic error:', result.error?.message)
      return res.status(500).json({ error: result.error?.message || 'LLM call failed' })
    }

    const rawText = result.content?.[0]?.text?.trim() || ''
    let parsed: { summary: string; key_facts: string[] }
    try {
      // Extract JSON from possible markdown code blocks
      const jsonMatch = rawText.match(/\{[\s\S]*\}/)
      parsed = JSON.parse(jsonMatch?.[0] || rawText)
    } catch {
      console.error('[update-memory] Failed to parse LLM response:', rawText)
      return res.status(500).json({ error: 'Failed to parse memory update' })
    }

    // Upsert memory
    const { error: upsertError } = await supabase
      .from('wa_conversation_memory')
      .upsert(
        {
          conversation_id: conversationId,
          summary: parsed.summary || existingSummary,
          key_facts: parsed.key_facts || existingFacts,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'conversation_id' }
      )

    if (upsertError) {
      console.error('[update-memory] Upsert error:', upsertError.message)
      return res.status(500).json({ error: upsertError.message })
    }

    return res.status(200).json({
      summary: parsed.summary,
      key_facts: parsed.key_facts,
    })
  } catch (err: any) {
    console.error('[update-memory] Error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}
