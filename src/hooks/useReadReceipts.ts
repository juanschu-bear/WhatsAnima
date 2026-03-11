import { useState } from 'react'
import type { TranslationKey } from '../lib/i18n'

type ReadAtMap = Record<string, string | null>

const AWAY_STATUSES: TranslationKey[] = [
  'avatarAtLunch', 'avatarOnPhone', 'avatarInMeeting', 'avatarOnToilet',
  'avatarGettingCoffee', 'avatarTakingNap', 'avatarWalkingDog', 'avatarAtGym',
]

export function useReadReceipts() {
  const [readAtMap, setReadAtMap] = useState<ReadAtMap>({})
  const [avatarAwayStatus, setAvatarAwayStatus] = useState<string | null>(null)

  function loadReadAts(messages: Array<{ id: string; read_at?: string | null }>) {
    const readAts: ReadAtMap = {}
    for (const msg of messages) {
      readAts[msg.id] = msg.read_at ?? null
    }
    setReadAtMap(readAts)
  }

  function simulateAvatarRead(messageId: string) {
    const roll = Math.random()

    if (roll < 0.15) {
      // 15% — away status (toilet, gym, lunch, etc.) → 8-30s delay
      const status = AWAY_STATUSES[Math.floor(Math.random() * AWAY_STATUSES.length)]
      const awayDuration = 8000 + Math.random() * 22000
      setAvatarAwayStatus(status)
      setTimeout(() => {
        setAvatarAwayStatus(null)
        markMessageRead(messageId)
      }, awayDuration)
    } else if (roll < 0.35) {
      // 20% — slow read, as if busy or distracted → 3-8s
      const delay = 3000 + Math.random() * 5000
      setTimeout(() => markMessageRead(messageId), delay)
    } else if (roll < 0.60) {
      // 25% — normal read → 1-3s
      const delay = 1000 + Math.random() * 2000
      setTimeout(() => markMessageRead(messageId), delay)
    } else {
      // 40% — quick read, actively chatting → 300-1200ms
      const delay = 300 + Math.random() * 900
      setTimeout(() => markMessageRead(messageId), delay)
    }
  }

  function markMessageRead(messageId: string) {
    const now = new Date().toISOString()
    setReadAtMap((prev) => ({ ...prev, [messageId]: now }))
    fetch('/api/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIds: [messageId] }),
    }).catch(() => {})
  }

  function markAsInstantlyRead(messageId: string) {
    setReadAtMap((prev) => ({ ...prev, [messageId]: new Date().toISOString() }))
  }

  return {
    readAtMap,
    avatarAwayStatus,
    loadReadAts,
    simulateAvatarRead,
    markAsInstantlyRead,
  }
}
