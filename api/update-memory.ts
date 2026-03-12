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

  const { conversationId, recentMessages, ownerId, contactId } = req.body ?? {}
  if (!conversationId || !Array.isArray(recentMessages)) {
    return res.status(400).json({ error: 'conversationId and recentMessages are required' })
  }

  try {
    // Load existing memory (gracefully handle missing table)
    const { data: existing, error: loadError } = await supabase
      .from('wa_conversation_memory')
      .select('summary, key_facts, behavioral_profile')
      .eq('conversation_id', conversationId)
      .maybeSingle()

    if (loadError && (loadError.code === '42P01' || loadError.message?.includes('does not exist'))) {
      console.warn('[update-memory] wa_conversation_memory table not found — skipping')
      return res.status(200).json({ ok: false, skipped: true, reason: 'table not created yet' })
    }

    const existingSummary = existing?.summary || ''
    const existingFacts = existing?.key_facts || []
    const existingBehavioral = existing?.behavioral_profile || {}

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

    // --- Load OPM perception logs for this session ---
    // These contain the behavioral/prosodic data that Canon and OPM captured
    let perceptionExcerpt = ''
    let canonContext = ''
    try {
      // Get perception logs from the last session window (last 4 hours)
      const sessionCutoff = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
      const { data: perceptionLogs } = await supabase
        .from('wa_perception_logs')
        .select('primary_emotion, secondary_emotion, behavioral_summary, prosodic_summary, conversation_hooks, fired_rules, audio_duration_sec, created_at')
        .eq('conversation_id', conversationId)
        .gte('created_at', sessionCutoff)
        .order('created_at', { ascending: true })

      if (perceptionLogs && perceptionLogs.length > 0) {
        const perceptionLines: string[] = []
        for (const log of perceptionLogs) {
          const parts: string[] = []
          if (log.primary_emotion) parts.push(`emotion: ${log.primary_emotion}`)
          if (log.secondary_emotion) parts.push(`secondary: ${log.secondary_emotion}`)
          if (log.behavioral_summary) parts.push(`behavior: ${log.behavioral_summary}`)
          if (log.prosodic_summary) {
            const p = log.prosodic_summary
            const prosodicParts: string[] = []
            if (p.speaking_rate) prosodicParts.push(`speed: ${p.speaking_rate}`)
            if (p.mean_pitch) prosodicParts.push(`pitch: ${p.mean_pitch}`)
            if (p.volume_mean) prosodicParts.push(`volume: ${p.volume_mean}`)
            if (p.mean_pause_duration) prosodicParts.push(`pauses: ${p.mean_pause_duration}`)
            if (prosodicParts.length > 0) parts.push(`prosody: [${prosodicParts.join(', ')}]`)
          }
          if (log.fired_rules?.length > 0) {
            const ruleNames = log.fired_rules.map((r: any) => typeof r === 'string' ? r : r.name || r.rule || '').filter(Boolean)
            if (ruleNames.length > 0) parts.push(`signals: ${ruleNames.join(', ')}`)
          }
          if (log.conversation_hooks?.length > 0) parts.push(`hooks: ${log.conversation_hooks.join(', ')}`)
          if (parts.length > 0) perceptionLines.push(`- ${parts.join(' | ')}`)
        }
        if (perceptionLines.length > 0) {
          perceptionExcerpt = perceptionLines.join('\n')
        }
      }

      // Load Canon baseline info if available
      if (contactId && ownerId) {
        const { data: baseline } = await supabase
          .from('wa_voice_baseline')
          .select('current_tier, tier_name, confidence, baseline_data, cumulative_audio_sec')
          .eq('contact_id', contactId)
          .eq('owner_id', ownerId)
          .maybeSingle()

        if (baseline && baseline.current_tier >= 1) {
          const bd = baseline.baseline_data
          canonContext = `Canon baseline: Tier ${baseline.current_tier}/5 "${baseline.tier_name}" (${Math.round(baseline.confidence * 100)}% confidence, ${Math.round(baseline.cumulative_audio_sec)}s audio)`
          if (bd?.emotion_distribution) {
            const topEmotions = Object.entries(bd.emotion_distribution)
              .sort(([, a]: any, [, b]: any) => b - a)
              .slice(0, 4)
              .map(([e, f]: any) => `${e} ${Math.round(f * 100)}%`)
            canonContext += `\nTypical emotion distribution: ${topEmotions.join(', ')}`
          }
        }
      }
    } catch (err: any) {
      console.warn('[update-memory] Perception log load failed (non-blocking):', err.message)
    }

    // Build existing behavioral profile text for merging
    const existingBehavioralText = (() => {
      if (!existingBehavioral || Object.keys(existingBehavioral).length === 0) return '(none yet)'
      const parts: string[] = []
      if (existingBehavioral.emotional_patterns?.length > 0) {
        parts.push(`Emotional patterns: ${existingBehavioral.emotional_patterns.join('; ')}`)
      }
      if (existingBehavioral.prosodic_tendencies?.length > 0) {
        parts.push(`Prosodic tendencies: ${existingBehavioral.prosodic_tendencies.join('; ')}`)
      }
      if (existingBehavioral.topic_reactions?.length > 0) {
        parts.push(`Topic-specific reactions: ${existingBehavioral.topic_reactions.join('; ')}`)
      }
      if (existingBehavioral.authenticity_markers?.length > 0) {
        parts.push(`Authenticity markers: ${existingBehavioral.authenticity_markers.join('; ')}`)
      }
      return parts.length > 0 ? parts.join('\n') : '(none yet)'
    })()

    const prompt = `You are a memory extraction system for an AI avatar that has ongoing conversations with a user. Extract and organize memories into FOUR layers — content AND behavior.

TODAY'S DATE: ${today}

EXISTING USER PROFILE (permanent facts about this user):
${existingProfile.length > 0 ? existingProfile.join('\n') : '(none yet)'}

EXISTING TIMELINE (dated events and milestones):
${existingTimeline.length > 0 ? existingTimeline.join('\n') : '(none yet)'}

EXISTING BEHAVIORAL PROFILE (how this user communicates — from OPM/Canon data):
${existingBehavioralText}
${canonContext ? `\n${canonContext}` : ''}

EXISTING SESSION SUMMARY:
${existingSummary || '(none yet)'}

SESSION CONVERSATION:
${conversationExcerpt}
${perceptionExcerpt ? `\nOPM PERCEPTION DATA FOR THIS SESSION (real-time emotional/prosodic readings per message):
${perceptionExcerpt}` : ''}

INSTRUCTIONS:
Extract memories into FOUR categories:

1. **summary**: A 2-4 sentence summary of THIS session — what was discussed, the user's mood, any decisions made. This replaces the previous session summary.

2. **profile_facts**: Permanent facts about the user as a JSON array of short strings. Things like: name, age, occupation, goals, learning style, interests, preferences, strengths, weaknesses. These should be stable over time. Merge with existing profile — update facts that changed, add new ones, keep unchanged ones.

3. **timeline_events**: Important events, milestones, or dated information as a JSON array of strings. Each entry MUST start with a date prefix in format "[YYYY-MM] description". Examples:
   - "[2026-02] Passed math exam with grade B+"
   - "[2026-03] Started preparing for physics final"
   Merge with existing timeline — add new events, never remove old ones, update if corrected. Keep max 30 most relevant entries.

4. **behavioral_profile**: HOW the user communicates — extracted from the OPM perception data above. This is NOT about what they say, but HOW they say it. JSON object with these arrays:
   - **emotional_patterns**: Recurring emotional states and what triggers them. E.g. "Gets excited (high energy, faster speech) when discussing AI/technology", "Becomes quieter and more measured when discussing business challenges", "Default resting state is calm-focused"
   - **prosodic_tendencies**: Voice/speech patterns. E.g. "Speaks faster when passionate (rate increases 20-30%)", "Uses longer pauses when thinking deeply", "Volume increases during storytelling"
   - **topic_reactions**: How specific topics affect their emotional/prosodic state. E.g. "Perception/OPM topics → high energy + authenticity spike", "Business strategy → measured, analytical tone", "Personal stories → warmer, softer voice"
   - **authenticity_markers**: What makes this person more or less authentic. E.g. "More authentic when improvising than reading", "Authenticity drops when discussing topics they're unsure about", "Most genuine during casual conversation"

   Merge with existing behavioral profile. Keep max 8 entries per category. Update entries that evolved, add new ones, keep unchanged ones. If no OPM perception data is available for this session, return the existing behavioral profile unchanged.

IMPORTANT: Only extract information from actual data. For behavioral_profile, ONLY use the OPM perception readings — never invent behavioral patterns from text alone.

Respond in EXACTLY this JSON format:
{"summary": "...", "profile_facts": ["..."], "timeline_events": ["[YYYY-MM] ..."], "behavioral_profile": {"emotional_patterns": ["..."], "prosodic_tendencies": ["..."], "topic_reactions": ["..."], "authenticity_markers": ["..."]}}`

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    const result = await response.json()
    if (!response.ok) {
      console.error('[update-memory] Anthropic error:', result.error?.message)
      return res.status(500).json({ error: result.error?.message || 'LLM call failed' })
    }

    const rawText = result.content?.[0]?.text?.trim() || ''
    let parsed: { summary: string; profile_facts: string[]; timeline_events: string[]; behavioral_profile?: any }
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

    // Merge behavioral profile — keep existing if LLM returned nothing
    const behavioralProfile = parsed.behavioral_profile && Object.keys(parsed.behavioral_profile).length > 0
      ? parsed.behavioral_profile
      : existingBehavioral

    // Upsert memory (behavioral_profile column is JSONB, added via ALTER TABLE)
    const { error: upsertError } = await supabase
      .from('wa_conversation_memory')
      .upsert(
        {
          conversation_id: conversationId,
          summary: parsed.summary || existingSummary,
          key_facts: mergedFacts,
          behavioral_profile: behavioralProfile,
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

    // --- Communication Style Learning (only for self-avatars) ---
    if (ownerId) {
      try {
        const { data: owner } = await supabase
          .from('wa_owners')
          .select('is_self_avatar, communication_style')
          .eq('id', ownerId)
          .maybeSingle()

        if (owner?.is_self_avatar) {
          const existingStyle = owner.communication_style || { traits: [], speech_patterns: [], thinking_style: [] }

          const stylePrompt = `You are a communication style analyzer. Study how the AVATAR responds in this conversation and extract personality & style patterns. The avatar is a clone of a real person — we want to learn how that person communicates.

EXISTING STYLE PROFILE:
${JSON.stringify(existingStyle, null, 2)}

CONVERSATION:
${conversationExcerpt}

INSTRUCTIONS:
Analyze only the AVATAR's messages (not the User's). Extract:

1. **traits**: General communication traits (e.g. "Uses humor and irony", "Very direct, no fluff", "Empathetic listener")
2. **speech_patterns**: Specific phrases, words, or language habits (e.g. "Says 'mega' and 'krass'", "Mixes German and Spanish", "Uses rhetorical questions")
3. **thinking_style**: How the person reasons and approaches topics (e.g. "Asks counter-questions before answering", "Uses analogies to explain", "Pragmatic problem-solver")

Merge with the existing style profile. Keep max 10 entries per category. Update entries that evolved, add new ones, keep unchanged ones.

Respond in EXACTLY this JSON format:
{"traits": ["..."], "speech_patterns": ["..."], "thinking_style": ["..."]}`

          const styleResponse = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 600,
              messages: [{ role: 'user', content: stylePrompt }],
            }),
          })

          if (styleResponse.ok) {
            const styleResult = await styleResponse.json()
            const styleText = styleResult.content?.[0]?.text?.trim() || ''
            try {
              const styleMatch = styleText.match(/\{[\s\S]*\}/)
              const styleData = JSON.parse(styleMatch?.[0] || styleText)
              await supabase
                .from('wa_owners')
                .update({ communication_style: styleData })
                .eq('id', ownerId)
            } catch {
              console.warn('[update-memory] Failed to parse style extraction:', styleText)
            }
          }
        }
      } catch (err: any) {
        console.warn('[update-memory] Style extraction skipped:', err.message)
      }
    }
    // --- End Communication Style Learning ---

    return res.status(200).json({
      summary: parsed.summary,
      profile_facts: parsed.profile_facts,
      timeline_events: parsed.timeline_events,
      behavioral_profile: behavioralProfile,
    })
  } catch (err: any) {
    console.error('[update-memory] Error:', err.message)
    return res.status(200).json({ ok: false, error: err.message })
  }
}
