import { useRef, useState } from 'react'
import { getStoredLocale, t } from '../lib/i18n'

interface Message {
  id: string
  sender: 'contact' | 'avatar'
  type: 'text' | 'voice' | 'video' | 'image' | 'call_summary'
  content: string | null
  media_url: string | null
  duration_sec: number | null
  created_at: string
}

function formatClock(totalSeconds: number) {
  const safeSeconds = Number.isFinite(totalSeconds) ? Math.max(0, totalSeconds) : 0
  const minutes = Math.floor(safeSeconds / 60)
  const seconds = Math.floor(safeSeconds % 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function useMessageSelection(messages: Message[], conversation: { wa_owners: { display_name: string }; wa_contacts: { display_name: string } } | null) {
  const locale = getStoredLocale()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [selectionMode, setSelectionMode] = useState(false)
  const [forwardModalOpen, setForwardModalOpen] = useState(false)
  const [forwardOwners, setForwardOwners] = useState<Array<{ id: string; display_name: string }>>([])
  const [forwardLoading, setForwardLoading] = useState(false)
  const [forwardSending, setForwardSending] = useState<string | null>(null)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const longPressTimerRef = useRef<number | null>(null)

  function toggleSelectMessage(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      if (next.size === 0) setSelectionMode(false)
      return next
    })
  }

  function handleMessagePress(id: string) {
    if (selectionMode) {
      toggleSelectMessage(id)
    }
  }

  function handleMessageLongPress(id: string) {
    if (!selectionMode) {
      setSelectionMode(true)
    }
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }

  function clearSelection() {
    setSelectionMode(false)
    setSelectedIds(new Set())
    setExportMenuOpen(false)
  }

  function getSelectedMessages(): Message[] {
    return messages.filter((m) => selectedIds.has(m.id))
  }

  function formatMessageForExport(msg: Message, ownerName: string, contactName: string): string {
    const sender = msg.sender === 'contact' ? contactName : ownerName
    const time = new Date(msg.created_at).toLocaleString()
    const content = msg.type === 'voice'
      ? `[Voice message${msg.duration_sec ? ` ${formatClock(msg.duration_sec)}` : ''}]${msg.content ? ` ${msg.content}` : ''}`
      : msg.type === 'call_summary'
      ? `[Call summary]${msg.content ? ` ${msg.content}` : ''}`
      : msg.type === 'image'
      ? `[Image]${msg.content ? ` ${msg.content}` : ''}`
      : msg.type === 'video'
      ? `[Video]${msg.content ? ` ${msg.content}` : ''}`
      : msg.content || ''
    return `[${time}] ${sender}: ${content}`
  }

  async function handleCopySelected() {
    const selected = getSelectedMessages()
    if (selected.length === 0) return
    const ownerName = conversation?.wa_owners.display_name || 'Avatar'
    const contactName = conversation?.wa_contacts.display_name || 'You'
    const text = selected.map((m) => formatMessageForExport(m, ownerName, contactName)).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      showToast(t(locale, 'copiedToClipboard'))
    } catch {
      showToast(t(locale, 'noTextToCopy'))
    }
    clearSelection()
  }

  function handleExportAsFile() {
    const selected = getSelectedMessages()
    if (selected.length === 0) return
    const ownerName = conversation?.wa_owners.display_name || 'Avatar'
    const contactName = conversation?.wa_contacts.display_name || 'You'
    const text = selected.map((m) => formatMessageForExport(m, ownerName, contactName)).join('\n')
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `chat-export-${new Date().toISOString().split('T')[0]}.txt`
    a.click()
    URL.revokeObjectURL(url)
    clearSelection()
  }

  async function handleExportToClipboard() {
    const selected = getSelectedMessages()
    if (selected.length === 0) return
    const ownerName = conversation?.wa_owners.display_name || 'Avatar'
    const contactName = conversation?.wa_contacts.display_name || 'You'
    const text = selected.map((m) => formatMessageForExport(m, ownerName, contactName)).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      showToast(t(locale, 'copiedToClipboard'))
    } catch {
      showToast(t(locale, 'noTextToCopy'))
    }
    clearSelection()
  }

  function showToast(message: string) {
    setToastMessage(message)
    setTimeout(() => setToastMessage(null), 2500)
  }

  return {
    locale,
    selectedIds,
    selectionMode,
    forwardModalOpen,
    setForwardModalOpen,
    forwardOwners,
    setForwardOwners,
    forwardLoading,
    setForwardLoading,
    forwardSending,
    setForwardSending,
    exportMenuOpen,
    setExportMenuOpen,
    toastMessage,
    longPressTimerRef,
    handleMessagePress,
    handleMessageLongPress,
    clearSelection,
    getSelectedMessages,
    handleCopySelected,
    handleExportAsFile,
    handleExportToClipboard,
    showToast,
  }
}
