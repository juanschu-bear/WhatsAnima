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

/**
 * GET /api/check-reminders?conversationId=xxx
 *
 * Checks for due reminders for a conversation.
 * Returns any reminders that are due now (due_at <= now AND NOT fired).
 * Also generates a natural avatar nudge message using the LLM.
 */
export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const conversationId = req.query?.conversationId
  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId is required' })
  }

  const { client: supabase, missing } = getSupabaseAdmin()
  if (!supabase) {
    return res.status(503).json({ error: `DB not configured – missing ${missing}` })
  }

  try {
    const now = new Date().toISOString()

    // Find reminders that are due and not yet fired
    const { data: dueReminders, error } = await supabase
      .from('wa_reminders')
      .select('id, reminder_text, due_at, source_fact')
      .eq('conversation_id', conversationId)
      .eq('fired', false)
      .lte('due_at', now)
      .order('due_at', { ascending: true })
      .limit(3)

    if (error) {
      // Table might not exist yet
      if (error.code === '42P01' || error.message?.includes('does not exist')) {
        return res.status(200).json({ reminders: [] })
      }
      throw error
    }

    if (!dueReminders || dueReminders.length === 0) {
      return res.status(200).json({ reminders: [] })
    }

    // Generate natural avatar message for the reminders
    const apiKey = process.env.ANTHROPIC_API_KEY
    const nudgeMessages: Array<{ id: string; message: string }> = []

    for (const reminder of dueReminders) {
      let nudgeText = reminder.reminder_text

      // If we have an API key, make the nudge more natural
      if (apiKey) {
        try {
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 150,
              messages: [{
                role: 'user',
                content: `You are a friendly avatar sending a proactive reminder to the user. Turn this reminder into a short, natural, caring message (1-2 sentences max). Be casual and warm, like a close friend who remembered something important.

REMINDER: "${reminder.reminder_text}"
ORIGINAL CONTEXT: "${reminder.source_fact || ''}"

Write ONLY the message text, nothing else. Match the language of the reminder/context.`,
              }],
            }),
          })

          if (response.ok) {
            const result = await response.json()
            const text = result.content?.[0]?.text?.trim()
            if (text) nudgeText = text
          }
        } catch {
          // Use raw reminder text as fallback
        }
      }

      nudgeMessages.push({ id: reminder.id, message: nudgeText })

      // Mark as fired
      await supabase
        .from('wa_reminders')
        .update({ fired: true, fired_at: now })
        .eq('id', reminder.id)
    }

    return res.status(200).json({ reminders: nudgeMessages })
  } catch (err: any) {
    console.error('[check-reminders] Error:', err.message)
    return res.status(200).json({ reminders: [] })
  }
}
