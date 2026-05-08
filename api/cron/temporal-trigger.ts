import { createClient } from '@supabase/supabase-js'
import { normalizeTimezone } from '../_lib/temporalCore.js'

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

function inQuietHours(now: Date, timezone: string, start?: string | null, end?: string | null): boolean {
  if (!start || !end) return false
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)
  const toMin = (t: string) => {
    const [h, m] = t.split(':').map((x) => Number(x))
    return h * 60 + (m || 0)
  }
  const current = toMin(local)
  const s = toMin(start)
  const e = toMin(end)
  if (s <= e) return current >= s && current < e
  return current >= s || current < e
}

function renderReminderText(eventType: string, triggerAt: string): string {
  const t = new Date(triggerAt).toISOString().slice(11, 16)
  const deltaMin = Math.round((new Date(triggerAt).getTime() - Date.now()) / 60_000)
  if (eventType === 'deadline') {
    if (deltaMin <= 15) return `Urgent reminder: your deadline is very close (${t}). Want a final 2-minute check now?`
    return `Reminder: your deadline is around ${t}. Want to do a short final check now?`
  }
  if (eventType === 'follow_up') return `Quick follow-up: you wanted to revisit this around now. Ready to continue?`
  if (eventType === 'conversation_continue') return `You said we should continue this around now. Want to pick it up?`
  if (eventType === 'morning_briefing') return `Good morning. Briefing: I can help you prioritize today's key items right now.`
  if (deltaMin <= 15) return `Urgent reminder: this starts in about ${Math.max(deltaMin, 0)} minutes.`
  if (deltaMin <= 60) return `Heads up: this planned item is coming up around ${t}.`
  return `Reminder: upcoming item around ${t}.`
}

export default async function handler(req: any, res: any) {
  if (!['GET', 'HEAD', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, HEAD, POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const supabase = getSupabaseAdmin()
  if (!supabase) return res.status(200).json({ ok: false, skipped: true, reason: 'supabase_not_configured' })

  try {
    const now = new Date()
    const upper = new Date(now.getTime() + 60 * 60_000).toISOString()
    const nowIso = now.toISOString()

    // Ensure one morning briefing event per user/avatar per day when enabled.
    try {
      const { data: prefs } = await supabase
        .from('wa_temporal_preferences')
        .select('user_id, avatar_name, timezone, morning_briefing')
        .eq('morning_briefing', true)
        .limit(200)
      for (const pref of prefs || []) {
        const timezone = normalizeTimezone(pref.timezone || 'UTC')
        const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }))
        if (localNow.getHours() < 6 || localNow.getHours() > 11) continue
        const startOfLocalDay = new Date(localNow)
        startOfLocalDay.setHours(0, 0, 0, 0)
        const endOfLocalDay = new Date(localNow)
        endOfLocalDay.setHours(23, 59, 59, 999)
        const { data: existingBriefing } = await supabase
          .from('wa_temporal_events')
          .select('id')
          .eq('user_id', pref.user_id)
          .eq('avatar_name', pref.avatar_name)
          .eq('event_type', 'morning_briefing')
          .gte('trigger_at', startOfLocalDay.toISOString())
          .lte('trigger_at', endOfLocalDay.toISOString())
          .limit(1)
          .maybeSingle()
        if (existingBriefing?.id) continue
        await supabase.from('wa_temporal_events').insert({
          user_id: pref.user_id,
          avatar_name: pref.avatar_name,
          event_type: 'morning_briefing',
          trigger_at: new Date(localNow.getTime() + 2 * 60_000).toISOString(),
          action: { channel: 'chat', source: 'daily_morning_briefing' },
          status: 'pending',
        })
      }
    } catch (briefingErr) {
      console.warn('[temporal-trigger] morning briefing setup failed', briefingErr)
    }

    const { data: pendingEvents } = await supabase
      .from('wa_temporal_events')
      .select('id, user_id, avatar_name, event_type, trigger_at, action, status')
      .eq('status', 'pending')
      .lte('trigger_at', upper)
      .order('trigger_at', { ascending: true })
      .limit(200)

    const events = Array.isArray(pendingEvents) ? pendingEvents : []
    let triggered = 0
    let skippedQuiet = 0
    let failed = 0

    for (const event of events) {
      try {
        const { data: latestConv } = await supabase
          .from('wa_conversations')
          .select('id, owner_id, contact_id')
          .eq('contact_id', event.user_id)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (!latestConv?.id) continue

        const { data: pref } = await supabase
          .from('wa_temporal_preferences')
          .select('timezone, quiet_hours_start, quiet_hours_end, proactive_calls, reminder_lead_minutes')
          .eq('user_id', event.user_id)
          .eq('avatar_name', event.avatar_name)
          .maybeSingle()

        const timezone = normalizeTimezone(pref?.timezone || 'UTC')
        if (inQuietHours(now, timezone, pref?.quiet_hours_start || null, pref?.quiet_hours_end || null)) {
          skippedQuiet += 1
          continue
        }

        const channel = String((event.action && (event.action as any).channel) || 'chat')
        const isUrgent = new Date(String(event.trigger_at)).getTime() - Date.now() <= 15 * 60_000
        if (channel === 'call' && pref?.proactive_calls) {
          await supabase.from('wa_outbound_calls').insert({
            conversation_id: latestConv.id,
            owner_id: latestConv.owner_id,
            contact_id: latestConv.contact_id,
            contact_email: 'unknown@example.com',
            requested_by_message_id: null,
            trigger_text: `[temporal-trigger] ${event.event_type}`,
            mode: 'video',
            status: isUrgent ? 'ringing' : 'scheduled',
            caller_display_name: event.avatar_name,
            scheduled_for: event.trigger_at,
            triggered_at: isUrgent ? nowIso : null,
            expires_at: null,
            metadata: { source: 'temporal_trigger' },
          })
        } else {
          await supabase.from('wa_messages').insert({
            conversation_id: latestConv.id,
            sender: 'avatar',
            type: 'text',
            content: renderReminderText(String(event.event_type), String(event.trigger_at)),
            media_url: null,
          })
        }

        await supabase
          .from('wa_temporal_events')
          .update({ status: 'triggered' })
          .eq('id', event.id)
          .eq('status', 'pending')

        try {
          await supabase
            .from('wa_temporal_events')
            .insert({
              user_id: event.user_id,
              avatar_name: event.avatar_name,
              event_type: 'follow_up',
              trigger_at: new Date(new Date(event.trigger_at).getTime() + 24 * 60 * 60_000).toISOString(),
              action: { channel: 'chat', source_event_id: event.id },
              status: 'pending',
            })
        } catch {
          // optional follow-up scheduling, ignore failures
        }

        triggered += 1
      } catch (error) {
        failed += 1
        console.error('[temporal-trigger] event failed', event?.id, error)
      }
    }

    if (req.method === 'HEAD') return res.status(200).end()
    return res.status(200).json({
      ok: true,
      now: nowIso,
      scanned: events.length,
      triggered,
      skipped_quiet_hours: skippedQuiet,
      failed,
    })
  } catch (error: any) {
    console.error('[temporal-trigger] failed', error)
    if (req.method === 'HEAD') return res.status(200).end()
    return res.status(200).json({ ok: false, error: error?.message || String(error) })
  }
}
