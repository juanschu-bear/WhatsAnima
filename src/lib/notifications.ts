/**
 * Notification helpers — sound playback, push subscription, badge count
 */
import { supabase } from './supabase'

/* ── Sound names ─────────────────────────────────────────────── */
export type NotificationSound = 'bubble' | 'chime' | 'pulse'

export const NOTIFICATION_SOUNDS: { id: NotificationSound; label: string }[] = [
  { id: 'chime', label: 'Chime' },
  { id: 'bubble', label: 'Bubble' },
  { id: 'pulse', label: 'Pulse' },
]

const SOUND_STORAGE_KEY = 'wa_notification_sound'

export function getStoredSound(): NotificationSound {
  try {
    const v = localStorage.getItem(SOUND_STORAGE_KEY)
    if (v === 'bubble' || v === 'chime' || v === 'pulse') return v
  } catch {}
  return 'chime'
}

export function setStoredSound(sound: NotificationSound) {
  try { localStorage.setItem(SOUND_STORAGE_KEY, sound) } catch {}
}

/* ── Audio playback ──────────────────────────────────────────── */
const audioCache = new Map<string, HTMLAudioElement>()

/** Preload all sounds so they're ready instantly */
export function preloadSounds() {
  for (const s of NOTIFICATION_SOUNDS) {
    const audio = new Audio(`/sounds/${s.id}.wav`)
    audio.preload = 'auto'
    audio.volume = 0.7
    audioCache.set(s.id, audio)
  }
}

/** Play the chosen notification sound */
export function playNotificationSound(sound?: NotificationSound) {
  const id = sound ?? getStoredSound()
  let audio = audioCache.get(id)
  if (!audio) {
    audio = new Audio(`/sounds/${id}.wav`)
    audio.volume = 0.7
    audioCache.set(id, audio)
  }
  // Reset to start if already playing
  audio.currentTime = 0
  audio.play().catch(() => { /* user hasn't interacted yet */ })
}

/* ── Visibility / focus helpers ──────────────────────────────── */
export function isAppVisible(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

/* ── Badge API ───────────────────────────────────────────────── */
let _unreadCount = 0

export function setUnreadBadge(count: number) {
  _unreadCount = count
  // Badging API (supported in Chrome, Edge, Samsung Internet)
  if ('setAppBadge' in navigator) {
    if (count > 0) (navigator as any).setAppBadge(count)
    else (navigator as any).clearAppBadge()
  }
  // Also tell the service worker (for when the page is hidden)
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'SET_BADGE', count })
  }
}

export function incrementUnreadBadge() {
  setUnreadBadge(_unreadCount + 1)
}

export function clearUnreadBadge() {
  setUnreadBadge(0)
}

/* ── Push subscription ───────────────────────────────────────── */
const VAPID_PUBLIC_KEY_STORAGE = 'wa_vapid_public_key'

/**
 * Request notification permission and subscribe to push.
 * Returns true if successfully subscribed.
 */
export async function subscribeToPush(userId: string): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('[notifications] Push not supported in this browser')
    return false
  }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return false

  try {
    const reg = await navigator.serviceWorker.ready

    // Get VAPID key from environment
    const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined
    if (!vapidKey) {
      console.warn('[notifications] VITE_VAPID_PUBLIC_KEY not set — push disabled')
      return false
    }

    // Convert VAPID key from base64 to Uint8Array
    const urlBase64ToUint8Array = (base64String: string) => {
      const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
      const raw = atob(base64)
      return Uint8Array.from(raw, (c) => c.charCodeAt(0))
    }

    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    })

    // Save subscription to Supabase
    const subJson = subscription.toJSON()
    const { error } = await supabase.from('wa_push_subscriptions').upsert(
      {
        user_id: userId,
        endpoint: subJson.endpoint,
        p256dh: subJson.keys?.p256dh ?? '',
        auth: subJson.keys?.auth ?? '',
        created_at: new Date().toISOString(),
      },
      { onConflict: 'endpoint' }
    )

    if (error) {
      console.error('[notifications] Failed to save push subscription:', error)
      return false
    }

    return true
  } catch (err) {
    console.error('[notifications] Push subscription failed:', err)
    return false
  }
}

/**
 * Unsubscribe from push and remove from DB.
 */
export async function unsubscribeFromPush(userId: string): Promise<void> {
  if (!('serviceWorker' in navigator)) return

  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) {
      const endpoint = sub.endpoint
      await sub.unsubscribe()
      // Remove from DB
      await supabase.from('wa_push_subscriptions').delete().eq('user_id', userId).eq('endpoint', endpoint)
    }
  } catch (err) {
    console.error('[notifications] Unsubscribe failed:', err)
  }
}

/**
 * Check if push is currently subscribed.
 */
export async function isPushSubscribed(): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    return !!sub
  } catch {
    return false
  }
}

/**
 * Show a local notification (when we get a message while the app is in background
 * but we don't have server-side push yet). This uses the Notification API directly.
 */
export function showLocalNotification(title: string, body: string, conversationId?: string) {
  if (Notification.permission !== 'granted') return
  if (!('serviceWorker' in navigator)) return

  navigator.serviceWorker.ready.then((reg) => {
    reg.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: `wa-msg-${conversationId || 'general'}`,
      renotify: true,
      vibrate: [200, 100, 200],
      data: {
        url: conversationId ? `/chat/${conversationId}` : '/',
      },
    })
  }).catch(() => {})
}
