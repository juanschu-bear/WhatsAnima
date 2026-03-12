import { useEffect, useRef } from 'react'

interface Message {
  id: string
  sender: 'contact' | 'avatar'
  content: string | null
}

interface UseSessionMemoryOptions {
  conversationId: string | undefined
  ownerId: string | undefined
  contactId: string | undefined
  messages: Message[]
  sending: boolean
  avatarStatus: string | null
  conversation: { id: string } | null
  sendAvatarReply: (text: string, options?: { useVoice?: boolean }) => Promise<boolean>
}

const SESSION_TIMEOUT_MS = 180_000 // 3 minutes
const DEFAULT_BUSY_COOLDOWN_MS = 600_000 // 10 minutes fallback when user says "busy" without duration
const REMINDER_CHECK_INTERVAL_MS = 60_000 // check for due reminders every 60s

/**
 * Patterns that indicate the user is busy / away, with optional duration extraction.
 * Supports German, Spanish, and English.
 */
const BUSY_PATTERNS = [
  // German
  /\b(?:bin|ich bin|bin gerade|bin jetzt|bin mal|erstmal)\s+(?:beschäftigt|busy|weg|unterwegs|afk|nicht da|offline)\b/i,
  /\b(?:melde mich|meld mich|schreib dir|antworte dir|antwort dir|bin)\s+(?:gleich|später|nachher|in)\b/i,
  /\b(?:brauche?|brauch)\s+(?:kurz|mal|erstmal|noch)?\s*(?:zeit|ruhe|pause)\b/i,
  /\b(?:bis gleich|bis später|bis nachher|bis dann|tschüss erstmal)\b/i,
  // Spanish
  /\b(?:estoy|voy a estar)\s+(?:ocupado|ocupada|busy|fuera|afk)\b/i,
  /\b(?:te escribo|te respondo|vuelvo)\s+(?:luego|después|en un rato|más tarde|ahorita)\b/i,
  /\b(?:necesito)\s+(?:un momento|tiempo|un rato)\b/i,
  /\b(?:hasta luego|hasta después|nos vemos)\b/i,
  // English
  /\b(?:i'm|im|i am|gonna be)\s+(?:busy|away|afk|offline|out|unavailable)\b/i,
  /\b(?:talk|write|text|respond|reply|get back)\s+(?:to you|you)?\s*(?:later|soon|in a bit|in a while)\b/i,
  /\b(?:give me|need)\s+(?:a moment|some time|a sec|a minute|space)\b/i,
  /\b(?:brb|gtg|gotta go|heading out)\b/i,
  /\b(?:chill|chill mal|relax|calm down|tranquilo|tranquila)\b/i,
]

/**
 * Extract a duration in ms from the user's message.
 * Examples: "in 30 Minuten", "en 1 hora", "in 2 hours", "eine halbe stunde"
 */
function extractDurationMs(text: string): number | null {
  const lower = text.toLowerCase()

  // "halbe stunde" / "media hora" / "half an hour"
  if (/\b(?:halbe\s*stunde|media\s*hora|half\s*(?:an?\s*)?hour)\b/.test(lower)) return 30 * 60 * 1000

  // Number + unit patterns
  const durationMatch = lower.match(
    /\b(?:in\s+)?(\d+(?:[.,]\d+)?)\s*(?:(?:minuten?|minutos?|minutes?|mins?|min)\b|(?:stunden?|horas?|hours?|hrs?|h)\b)/
  )
  if (durationMatch) {
    const value = parseFloat(durationMatch[1].replace(',', '.'))
    const isHours = /(?:stunden?|horas?|hours?|hrs?|h)\b/.test(durationMatch[0])
    return Math.round(value * (isHours ? 3600000 : 60000))
  }

  // "eine stunde" / "una hora" / "an hour" / "one hour"
  if (/\b(?:eine?\s*stunde|una\s*hora|an?\s*hour|one\s*hour)\b/.test(lower)) return 60 * 60 * 1000

  // "ein paar minuten" / "unos minutos" / "a few minutes"
  if (/\b(?:(?:ein )?paar\s*minuten|unos\s*minutos|a few\s*minutes)\b/.test(lower)) return 10 * 60 * 1000

  return null
}

/**
 * Check if the user is telling the avatar to chill / stop nudging.
 */
function detectUserBusy(text: string): { isBusy: boolean; cooldownMs: number | null } {
  if (!text || text.length < 3) return { isBusy: false, cooldownMs: null }
  const isBusy = BUSY_PATTERNS.some((pattern) => pattern.test(text))
  if (!isBusy) return { isBusy: false, cooldownMs: null }
  const cooldownMs = extractDurationMs(text)
  return { isBusy: true, cooldownMs }
}

export function useSessionMemory({
  conversationId,
  ownerId,
  contactId,
  messages,
  sending,
  avatarStatus,
  conversation,
  sendAvatarReply,
}: UseSessionMemoryOptions) {
  const sessionTimerRef = useRef<number | null>(null)
  const sessionMemorySavedRef = useRef(false)
  const busyCooldownUntilRef = useRef<number>(0) // timestamp until which avatar should not nudge
  const nudgeCountRef = useRef(0) // how many nudges sent without user reply

  function triggerMemoryUpdate() {
    if (!conversationId || sessionMemorySavedRef.current) return
    sessionMemorySavedRef.current = true
    const recent = messages.slice(-40).map((m) => ({
      role: m.sender === 'contact' ? 'user' : 'assistant',
      content: (m.content || '').trim(),
    })).filter((m) => m.content.length > 0)
    if (recent.length < 3) return
    console.log('[Memory] Session ended — saving memory (%d messages)', recent.length)
    fetch('/api/update-memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, recentMessages: recent, ownerId, contactId }),
    }).catch((err) => console.error('[Memory] Update failed:', err))
  }

  function maybeAvatarNudge() {
    if (!conversationId || !conversation || sending || avatarStatus) return
    const last = messages[messages.length - 1]
    if (!last || last.sender !== 'avatar') return

    // Respect busy cooldown
    if (Date.now() < busyCooldownUntilRef.current) {
      const remainingMs = busyCooldownUntilRef.current - Date.now()
      console.log('[Nudge] User is busy — waiting %ds more', Math.round(remainingMs / 1000))
      // Re-schedule check after cooldown expires
      if (sessionTimerRef.current) window.clearTimeout(sessionTimerRef.current)
      sessionTimerRef.current = window.setTimeout(() => {
        busyCooldownUntilRef.current = 0
        nudgeCountRef.current = 0
        maybeAvatarNudge()
      }, remainingMs)
      return
    }

    // After first nudge without reply, lower probability and increase delay
    if (nudgeCountRef.current >= 2) {
      console.log('[Nudge] Already nudged %d times without reply — backing off', nudgeCountRef.current)
      return
    }

    // First nudge: 40% chance, second nudge: 15% chance
    const nudgeChance = nudgeCountRef.current === 0 ? 0.4 : 0.15
    if (Math.random() > nudgeChance) return

    nudgeCountRef.current += 1

    const prompt = nudgeCountRef.current === 1
      ? 'The user has been quiet for a few minutes. Send a brief, natural follow-up based on the conversation context — like checking in, asking if they need more time, or offering encouragement. Keep it to 1-2 short sentences. Be natural, not robotic.'
      : 'The user still hasn\'t replied after your last follow-up. Send one final gentle check-in — maybe ask if they\'re busy or if they want to continue later. Be understanding and chill, not pushy. One short sentence max.'

    sendAvatarReply(prompt, { useVoice: false })
  }

  function resetSessionTimer() {
    sessionMemorySavedRef.current = false
    if (sessionTimerRef.current) window.clearTimeout(sessionTimerRef.current)

    // Check the latest contact message for busy signals
    const lastContactMsg = [...messages].reverse().find((m) => m.sender === 'contact')
    if (lastContactMsg?.content) {
      const { isBusy, cooldownMs } = detectUserBusy(lastContactMsg.content)
      if (isBusy) {
        const effectiveCooldown = cooldownMs ?? DEFAULT_BUSY_COOLDOWN_MS
        busyCooldownUntilRef.current = Date.now() + effectiveCooldown
        console.log('[Session] User indicated busy — cooldown %ds', Math.round(effectiveCooldown / 1000))

        // Schedule nudge check after cooldown
        sessionTimerRef.current = window.setTimeout(() => {
          busyCooldownUntilRef.current = 0
          nudgeCountRef.current = 0
          triggerMemoryUpdate()
          maybeAvatarNudge()
        }, effectiveCooldown)
        return
      }
    }

    // If the latest message is from the contact (user replied), reset nudge counter
    const last = messages[messages.length - 1]
    if (last?.sender === 'contact') {
      nudgeCountRef.current = 0
    }

    // Progressive delay: base 3min, but after a nudge wait longer (5min)
    const timeoutMs = nudgeCountRef.current > 0 ? 300_000 : SESSION_TIMEOUT_MS
    sessionTimerRef.current = window.setTimeout(() => {
      triggerMemoryUpdate()
      maybeAvatarNudge()
    }, timeoutMs)
  }

  // Reset session timer on every new message
  useEffect(() => {
    if (messages.length > 0) resetSessionTimer()
    return () => { if (sessionTimerRef.current) window.clearTimeout(sessionTimerRef.current) }
  }, [messages.length])

  // Save memory when user leaves the page
  useEffect(() => {
    const handleUnload = () => triggerMemoryUpdate()
    window.addEventListener('beforeunload', handleUnload)
    return () => window.removeEventListener('beforeunload', handleUnload)
  }, [conversationId, messages])

  // --- Proactive reminders from memory ---
  // Poll for due reminders and have the avatar deliver them naturally
  const reminderTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!conversationId) return

    function checkReminders() {
      fetch(`/api/check-reminders?conversationId=${conversationId}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.reminders && data.reminders.length > 0) {
            for (const reminder of data.reminders) {
              // Send the reminder as a text message from the avatar
              sendAvatarReply(
                `SYSTEM INSTRUCTION: Send this proactive reminder to the user as a natural, caring message. Do NOT mention that this is a reminder system — just bring it up naturally like you remembered it yourself. Here is what you need to remind them about: "${reminder.message}"`,
                { useVoice: false }
              )
            }
          }
        })
        .catch(() => {}) // silently fail
    }

    // Initial check after a short delay (don't fire immediately on page load)
    const initialTimer = window.setTimeout(checkReminders, 5000)

    // Then check periodically
    reminderTimerRef.current = window.setInterval(checkReminders, REMINDER_CHECK_INTERVAL_MS)

    return () => {
      window.clearTimeout(initialTimer)
      if (reminderTimerRef.current) window.clearInterval(reminderTimerRef.current)
    }
  }, [conversationId])

  return { triggerMemoryUpdate }
}
