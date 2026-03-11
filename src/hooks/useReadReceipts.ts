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
    const willBeAway = Math.random() < 0.2
    if (willBeAway) {
      const status = AWAY_STATUSES[Math.floor(Math.random() * AWAY_STATUSES.length)]
      const awayDuration = 3000 + Math.random() * 5000
      setAvatarAwayStatus(status)
      setTimeout(() => {
        setAvatarAwayStatus(null)
        markMessageRead(messageId)
      }, awayDuration)
    } else {
      const delay = 200 + Math.random() * 1300
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
