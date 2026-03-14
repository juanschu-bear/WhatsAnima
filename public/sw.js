/* WhatsAnima Service Worker — push notifications & background message handling */

const CACHE_NAME = 'wa-sw-v1'

/* ── Push event ─────────────────────────────────────────────── */
self.addEventListener('push', (event) => {
  let data = { title: 'WhatsAnima', body: 'New message', icon: '/icon-192.png', badge: '/icon-192.png', tag: 'wa-msg' }
  try {
    if (event.data) {
      const payload = event.data.json()
      data = { ...data, ...payload }
    }
  } catch { /* use defaults */ }

  const options = {
    body: data.body,
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    tag: data.tag || 'wa-msg',
    renotify: true,
    vibrate: [200, 100, 200],
    data: {
      url: data.url || '/',
      conversationId: data.conversationId,
      sound: data.sound || 'chime',
    },
  }

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  )
})

/* ── Notification click — open or focus the app ─────────────── */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const targetUrl = event.notification.data?.url || '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Focus existing window if available
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          if (targetUrl !== '/') client.navigate(targetUrl)
          return client.focus()
        }
      }
      // Otherwise open a new window
      return self.clients.openWindow(targetUrl)
    })
  )
})

/* ── Activate: claim clients immediately ────────────────────── */
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

/* ── Install: skip waiting ──────────────────────────────────── */
self.addEventListener('install', () => {
  self.skipWaiting()
})

/* ── Message handler for badge updates from the main app ────── */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SET_BADGE') {
    const count = event.data.count || 0
    if ('setAppBadge' in navigator) {
      if (count > 0) navigator.setAppBadge(count)
      else navigator.clearAppBadge()
    }
  }
})
