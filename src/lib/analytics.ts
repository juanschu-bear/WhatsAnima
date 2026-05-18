import { supabase } from './supabase'

// --- Device Detection ---

function getDeviceType(): string {
  const ua = navigator.userAgent.toLowerCase()
  if (/ipad|tablet/i.test(ua)) return 'tablet'
  if (/iphone|ipod|android.*mobile/i.test(ua)) return 'mobile_ios'
  if (/android/i.test(ua)) return 'mobile_android'
  return 'desktop'
}

function getBrowser(): string {
  const ua = navigator.userAgent
  if (ua.includes('CriOS') || (ua.includes('Chrome') && !ua.includes('Edg'))) return 'chrome'
  if (ua.includes('Safari') && !ua.includes('Chrome')) return 'safari'
  if (ua.includes('Firefox')) return 'firefox'
  if (ua.includes('Edg')) return 'edge'
  return 'other'
}

function isPWA(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as any).standalone === true
}

function getDisplayMode(): string {
  if (window.matchMedia('(display-mode: standalone)').matches) return 'standalone'
  if (window.matchMedia('(display-mode: fullscreen)').matches) return 'fullscreen'
  return 'browser'
}

// --- Event Queue ---

interface AnalyticsEvent {
  event_type: string
  event_data: Record<string, unknown>
  avatar_name?: string
  created_at: string
}

const FLUSH_INTERVAL = 30_000
const MAX_BATCH = 50

let eventQueue: AnalyticsEvent[] = []
let flushTimer: ReturnType<typeof setInterval> | null = null
let userId: string | null = null
let sessionId: string | null = null

function generateSessionId(): string {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// --- Public API ---

export function initAnalytics() {
  sessionId = generateSessionId()

  supabase.auth.getUser().then(({ data }) => {
    if (data?.user) {
      userId = data.user.id
      track('session_start', { is_pwa: isPWA(), display_mode: getDisplayMode() })
      upsertProfile()
    }
  })

  // Flush on interval
  flushTimer = setInterval(flush, FLUSH_INTERVAL)

  // Flush when app goes to background
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })

  // Flush before unload
  window.addEventListener('beforeunload', flush)

  // Listen for PWA install
  window.addEventListener('appinstalled', () => {
    track('pwa_installed', { platform: getDeviceType() })
  })
}

export function track(eventType: string, eventData: Record<string, unknown> = {}, avatarName?: string) {
  eventQueue.push({
    event_type: eventType,
    event_data: eventData,
    avatar_name: avatarName,
    created_at: new Date().toISOString(),
  })

  if (eventQueue.length >= MAX_BATCH) flush()
}

export function trackPageView(path: string, fromPath?: string) {
  track('page_view', { path, from_path: fromPath })
}

export function trackCallStart(avatarName: string, callMode: string = 'video') {
  track('call_start', { call_mode: callMode }, avatarName)
}

export function trackCallEnd(avatarName: string, durationSeconds: number, endedBy: string = 'user') {
  track('call_end', { duration_seconds: durationSeconds, ended_by: endedBy }, avatarName)
}

export function trackCallError(avatarName: string, errorType: string) {
  track('call_error', { error_type: errorType }, avatarName)
}

export function trackMessageSent(avatarName: string, type: 'text' | 'voice' | 'video', meta: Record<string, unknown> = {}) {
  const eventType = type === 'text' ? 'message_sent' : type === 'voice' ? 'voice_message_sent' : 'video_message_sent'
  track(eventType, meta, avatarName)
}

export function trackFeature(feature: string, data: Record<string, unknown> = {}) {
  track(feature, data)
}

// --- Flush ---

async function flush() {
  if (!userId || eventQueue.length === 0) return

  const batch = eventQueue.splice(0, MAX_BATCH)
  const deviceType = getDeviceType()
  const browser = getBrowser()
  const pwa = isPWA()
  const displayMode = getDisplayMode()
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  const screenWidth = window.innerWidth

  const rows = batch.map(e => ({
    user_id: userId,
    event_type: e.event_type,
    event_data: e.event_data,
    session_id: sessionId,
    avatar_name: e.avatar_name || null,
    device_type: deviceType,
    browser,
    is_pwa: pwa,
    display_mode: displayMode,
    screen_width: screenWidth,
    timezone: tz,
    created_at: e.created_at,
  }))

  try {
    await supabase.from('wa_analytics').insert(rows)
  } catch (err) {
    // Put events back if flush failed
    eventQueue.unshift(...batch)
    console.warn('[Analytics] flush failed:', err)
  }
}

// --- Profile ---

async function upsertProfile() {
  if (!userId) return

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return

  const profile = {
    user_id: userId,
    email: user.email || '',
    last_active_at: new Date().toISOString(),
    pwa_installed: isPWA(),
    device_type: getDeviceType(),
    browser: getBrowser(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    updated_at: new Date().toISOString(),
  }

  try {
    await supabase.from('wa_user_profiles').upsert(profile, { onConflict: 'user_id' })
  } catch (err) {
    console.warn('[Analytics] profile upsert failed:', err)
  }
}

export function cleanup() {
  flush()
  if (flushTimer) clearInterval(flushTimer)
}
