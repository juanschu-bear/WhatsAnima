import { useRef, useState } from 'react'

type ReactionsMap = Record<string, { contact?: string; avatar?: string }>

const QUICK_EMOJIS = ['\u{1F44D}', '\u{2764}\u{FE0F}', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F64F}']

export { QUICK_EMOJIS }

export function useReactions() {
  const [reactionsMap, setReactionsMap] = useState<ReactionsMap>({})
  const [emojiPickerMessageId, setEmojiPickerMessageId] = useState<string | null>(null)
  const doubleTapRef = useRef<{ id: string; time: number } | null>(null)

  function loadReactions(messageIds: string[]) {
    if (messageIds.length === 0) return
    fetch(`/api/react-message?messageIds=${messageIds.join(',')}`)
      .then((r) => r.json())
      .then((reactions: Array<{ message_id: string; emoji: string; reactor: string }>) => {
        if (!Array.isArray(reactions)) return
        const map: ReactionsMap = {}
        for (const r of reactions) {
          if (!map[r.message_id]) map[r.message_id] = {}
          if (r.reactor === 'contact') map[r.message_id].contact = r.emoji
          if (r.reactor === 'avatar') map[r.message_id].avatar = r.emoji
        }
        setReactionsMap(map)
      })
      .catch(() => {})
  }

  async function addReaction(messageId: string, emoji: string) {
    setReactionsMap((prev) => ({
      ...prev,
      [messageId]: { ...prev[messageId], contact: emoji },
    }))
    setEmojiPickerMessageId(null)
    try {
      await fetch('/api/react-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, emoji, reactor: 'contact' }),
      })
    } catch (err) {
      console.error('[Reaction] Failed:', err)
    }
  }

  async function removeReaction(messageId: string) {
    setReactionsMap((prev) => {
      const updated = { ...prev }
      if (updated[messageId]) {
        const { contact: _, ...rest } = updated[messageId]
        updated[messageId] = rest
      }
      return updated
    })
    try {
      await fetch('/api/react-message', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, reactor: 'contact' }),
      })
    } catch (err) {
      console.error('[Reaction] Remove failed:', err)
    }
  }

  function handleDoubleTap(messageId: string, selectionMode: boolean) {
    if (selectionMode) return
    const now = Date.now()
    if (doubleTapRef.current?.id === messageId && now - doubleTapRef.current.time < 350) {
      doubleTapRef.current = null
      if (reactionsMap[messageId]?.contact) {
        removeReaction(messageId)
      } else {
        setEmojiPickerMessageId((prev) => prev === messageId ? null : messageId)
      }
    } else {
      doubleTapRef.current = { id: messageId, time: now }
    }
  }

  function maybeAvatarReact(messageId: string) {
    if (Math.random() > 0.25) return
    const delay = 1500 + Math.random() * 4000
    const emoji = QUICK_EMOJIS[Math.floor(Math.random() * QUICK_EMOJIS.length)]
    setTimeout(() => {
      setReactionsMap((prev) => ({
        ...prev,
        [messageId]: { ...prev[messageId], avatar: emoji },
      }))
      fetch('/api/react-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, emoji, reactor: 'avatar' }),
      }).catch(() => {})
    }, delay)
  }

  function closeEmojiPicker() {
    setEmojiPickerMessageId(null)
  }

  function toggleReactionPicker(messageId: string) {
    if (reactionsMap[messageId]?.contact) {
      removeReaction(messageId)
    } else {
      setEmojiPickerMessageId((prev) => prev === messageId ? null : messageId)
    }
  }

  return {
    reactionsMap,
    emojiPickerMessageId,
    loadReactions,
    addReaction,
    removeReaction,
    handleDoubleTap,
    maybeAvatarReact,
    closeEmojiPicker,
    toggleReactionPicker,
  }
}
