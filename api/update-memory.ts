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
    // Load existing memory (gracefully handle missing table)
    const { data: existing, error: loadError } = await supabase
      .from('wa_conversation_memory')
      .select('summary, key_facts')
      .eq('conversation_id', conversationId)
      .maybeSingle()

    if (loadError && (loadError.code === '42P01' || loadError.message?.includes('does not exist'))) {
      console.warn('[update-memory] wa_conversation_memory table not found — skipping')
      return res.status(200).json({ ok: false, skipped: true, reason: 'table not created yet' })
    }

    const existingSummary = existing?.summary || ''
    const existingFacts = existing?.key_facts || []

    // Separate user profile facts from timeline events
    const existingProfile: string[] = []
    const existingTimeline: string[] = []
    for (const fact of (Array.isArray(existingFacts) ? existingFacts : [])) {
      if (typeof fact === 'string' && /^\[\d{4}-\d{2}/.test(fact)) {
        existingTimeline.push(fact)
      } else {
        existingProfile.push(fact as string)
      }
    }

    const today = new Date().toISOString().split('T')[0]

    // Build the conversation excerpt for the LLM
    const conversationExcerpt = recentMessages
      .map((m: any) => `${m.role === 'user' ? 'User' : 'Avatar'}: ${m.content}`)
      .join('\n')

    const prompt = `You are a memory extraction system for an AI avatar that has ongoing conversations with a user. Extract and organize memories into three layers.

TODAY'S DATE: ${today}

EXISTING USER PROFILE (permanent facts about this user):
${existingProfile.length > 0 ? existingProfile.join('\n') : '(none yet)'}

EXISTING TIMELINE (dated events and milestones):
${existingTimeline.length > 0 ? existingTimeline.join('\n') : '(none yet)'}

EXISTING SESSION SUMMARY:
${existingSummary || '(none yet)'}

SESSION CONVERSATION:
${conversationExcerpt}

INSTRUCTIONS:
Extract memories into three categories:

1. **summary**: A 2-4 sentence summary of THIS session — what was discussed, the user's mood, any decisions made. This replaces the previous session summary.

2. **profile_facts**: Permanent facts about the user as a JSON array of short strings. Things like: name, age, occupation, goals, learning style, interests, preferences, strengths, weaknesses. These should be stable over time. Merge with existing profile — update facts that changed, add new ones, keep unchanged ones.

3. **timeline_events**: Important events, milestones, or dated information as a JSON array of strings. Each entry MUST start with a date prefix in format "[YYYY-MM] description". Examples:
   - "[2026-02] Passed math exam with grade B+"
   - "[2026-03] Started preparing for physics final"
   - "[2026-03] Mentioned feeling stressed about workload"
   Merge with existing timeline — add new events, never remove old ones, update if corrected. Keep max 30 most relevant entries.

IMPORTANT: Only extract information the user actually shared. Never invent or assume facts.

Respond in EXACTLY this JSON format:
{"summary": "...", "profile_facts": ["fact 1", "fact 2"], "timeline_events": ["[YYYY-MM] event 1", "[YYYY-MM] event 2"]}`

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    const result = await response.json()
    if (!response.ok) {
      console.error('[update-memory] Anthropic error:', result.error?.message)
      return res.status(500).json({ error: result.error?.message || 'LLM call failed' })
    }

    const rawText = result.content?.[0]?.text?.trim() || ''
    let parsed: { summary: string; profile_facts: string[]; timeline_events: string[] }
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/)
      parsed = JSON.parse(jsonMatch?.[0] || rawText)
    } catch {
      console.error('[update-memory] Failed to parse LLM response:', rawText)
      return res.status(500).json({ error: 'Failed to parse memory update' })
    }

    // Merge profile facts and timeline events into a single key_facts array
    // Timeline events are prefixed with [YYYY-MM] so they can be separated on read
    const mergedFacts = [
      ...(parsed.profile_facts || existingProfile),
      ...(parsed.timeline_events || existingTimeline),
    ]

    // Upsert memory
    const { error: upsertError } = await supabase
      .from('wa_conversation_memory')
      .upsert(
        {
          conversation_id: conversationId,
          summary: parsed.summary || existingSummary,
          key_facts: mergedFacts,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'conversation_id' }
      )

    if (upsertError) {
      // Gracefully handle missing table
      if (upsertError.code === '42P01' || upsertError.message?.includes('does not exist')) {
        console.warn('[update-memory] wa_conversation_memory table not found — skipping upsert')
        return res.status(200).json({ ok: false, skipped: true, reason: 'table not created yet' })
      }
      console.error('[update-memory] Upsert error:', upsertError.message)
      return res.status(200).json({ ok: false, error: upsertError.message })
    }

    return res.status(200).json({
      summary: parsed.summary,
      profile_facts: parsed.profile_facts,
      timeline_events: parsed.timeline_events,
    })
  } catch (err: any) {
    console.error('[update-memory] Error:', err.message)
    return res.status(200).json({ ok: false, error: err.message })
  }
}
