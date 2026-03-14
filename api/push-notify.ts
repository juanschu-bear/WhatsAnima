/**
 * POST /api/push-notify
 * Sends a Web Push notification to all subscribed devices for a given user.
 *
 * Body: { userId, title, body, conversationId?, url?, sound? }
 *
 * Required env vars: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL
 */
import { createClient } from '@supabase/supabase-js'
import webpush from 'web-push'

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

  const { client: supabase, missing } = getSupabaseAdmin()
  if (!supabase) {
    return res.status(503).json({ error: `DB not configured – missing ${missing}` })
  }

  const vapidPublic = process.env.VAPID_PUBLIC_KEY
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY
  const vapidEmail = process.env.VAPID_EMAIL || 'mailto:hello@whatsanima.com'

  if (!vapidPublic || !vapidPrivate) {
    return res.status(503).json({ error: 'VAPID keys not configured' })
  }

  webpush.setVapidDetails(vapidEmail, vapidPublic, vapidPrivate)

  const { userId, title, body, conversationId, url, sound } = req.body ?? {}

  if (!userId || !body) {
    return res.status(400).json({ error: 'userId and body are required' })
  }

  try {
    // Fetch all push subscriptions for this user
    const { data: subs, error: fetchError } = await supabase
      .from('wa_push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('user_id', userId)

    if (fetchError) {
      console.error('[push-notify] Fetch subscriptions error:', fetchError)
      return res.status(500).json({ error: 'Failed to fetch subscriptions' })
    }

    if (!subs || subs.length === 0) {
      return res.status(200).json({ sent: 0, message: 'No subscriptions found' })
    }

    const payload = JSON.stringify({
      title: title || 'WhatsAnima',
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: `wa-msg-${conversationId || 'general'}`,
      url: url || (conversationId ? `/chat/${conversationId}` : '/'),
      conversationId,
      sound: sound || 'chime',
    })

    let sent = 0
    const staleEndpoints: string[] = []

    await Promise.allSettled(
      subs.map(async (sub) => {
        const pushSub = {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        }
        try {
          await webpush.sendNotification(pushSub, payload)
          sent++
        } catch (err: any) {
          // If subscription is expired/invalid (410 Gone or 404), mark for cleanup
          if (err.statusCode === 410 || err.statusCode === 404) {
            staleEndpoints.push(sub.endpoint)
          } else {
            console.error('[push-notify] Send failed for endpoint:', sub.endpoint, err.message)
          }
        }
      })
    )

    // Cleanup stale subscriptions
    if (staleEndpoints.length > 0) {
      await supabase
        .from('wa_push_subscriptions')
        .delete()
        .in('endpoint', staleEndpoints)
    }

    return res.status(200).json({ sent, cleaned: staleEndpoints.length })
  } catch (err: any) {
    console.error('[push-notify] Error:', err.message || err)
    return res.status(500).json({ error: err.message || 'Push notification failed' })
  }
}
