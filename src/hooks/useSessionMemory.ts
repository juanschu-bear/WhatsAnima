import { useEffect, useRef } from 'react'

interface Message {
  id: string
  sender: 'contact' | 'avatar'
  content: string | null
}

interface UseSessionMemoryOptions {
  conversationId: string | undefined
  ownerId: string | undefined
  messages: Message[]
  sending: boolean
  avatarStatus: string | null
  conversation: { id: string } | null
  sendAvatarReply: (text: string, options?: { useVoice?: boolean }) => Promise<void>
}

const SESSION_TIMEOUT_MS = 180_000 // 3 minutes

export function useSessionMemory({
  conversationId,
  ownerId,
  messages,
  sending,
  avatarStatus,
  conversation,
  sendAvatarReply,
}: UseSessionMemoryOptions) {
  const sessionTimerRef = useRef<number | null>(null)
  const sessionMemorySavedRef = useRef(false)

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
      body: JSON.stringify({ conversationId, recentMessages: recent, ownerId }),
    }).catch((err) => console.error('[Memory] Update failed:', err))
  }

  function maybeAvatarNudge() {
    if (!conversationId || !conversation || sending || avatarStatus) return
    const last = messages[messages.length - 1]
    if (!last || last.sender !== 'avatar') return
    if (Math.random() > 0.4) return
    sendAvatarReply('The user has been quiet for a few minutes. Send a brief, natural follow-up based on the conversation context — like checking in, asking if they need more time, or offering encouragement. Keep it to 1-2 short sentences. Be natural, not robotic.', {
      useVoice: false,
    })
  }

  function resetSessionTimer() {
    sessionMemorySavedRef.current = false
    if (sessionTimerRef.current) window.clearTimeout(sessionTimerRef.current)
    sessionTimerRef.current = window.setTimeout(() => {
      triggerMemoryUpdate()
      maybeAvatarNudge()
    }, SESSION_TIMEOUT_MS)
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

  return { triggerMemoryUpdate }
}
