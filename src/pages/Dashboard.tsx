import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import {
  createOwnerIfNeeded,
  deleteInvitationLink,
  generateInvitationLink,
  getOwnerDashboardStats,
  listConversations,
  listInvitationLinks,
  listMessages,
  toggleInvitationLink,
  type ConversationListItem,
  type MessageType,
  type OwnerDashboardStats,
} from '../lib/api'

interface InvitationLink {
  id: string
  token: string
  label: string | null
  use_count: number
  active: boolean
}

interface MessageRow {
  id: string
  sender: 'contact' | 'avatar'
  type: MessageType
  content: string | null
  media_url: string | null
  duration_sec: number | null
  created_at: string
}

interface OwnerProfile {
  id: string
  display_name: string | null
  first_name: string | null
  last_name: string | null
  avatar_url: string | null
}

function formatTimestamp(dateStr?: string | null) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function formatMessageTime(dateStr: string) {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatMessagePreview(content: string | null, type: MessageType) {
  if (content?.trim()) return content
  return {
    voice: 'Voice message',
    video: 'Video message',
    image: 'Image',
    text: 'Message',
  }[type]
}

function getContactName(conversation: ConversationListItem) {
  const contact = conversation.wa_contacts
  return contact?.display_name || contact?.email || 'Guest'
}

function getInitials(name: string) {
  const parts = name.split(/\s+/).filter(Boolean)
  return (parts[0]?.[0] || '') + (parts[1]?.[0] || '')
}

function isOnline(dateStr?: string | null) {
  if (!dateStr) return false
  return Date.now() - new Date(dateStr).getTime() < 5 * 60 * 1000
}

function summarizeTopics(messages: MessageRow[]) {
  const text = messages
    .map((message) => message.content || '')
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')

  const stopWords = new Set([
    'the', 'and', 'you', 'that', 'have', 'for', 'with', 'this', 'your', 'from',
    'are', 'was', 'but', 'not', 'can', 'ich', 'und', 'der', 'die', 'das', 'ein',
    'eine', 'mit', 'ist', 'que', 'para', 'con', 'los', 'las', 'una', 'pero',
  ])

  const counts = new Map<string, number>()
  for (const word of text.split(/\s+/)) {
    if (word.length < 4 || stopWords.has(word)) continue
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([word]) => word)
}

export default function Dashboard() {
  const { user, signOut } = useAuth()
  const [ownerId, setOwnerId] = useState<string | null>(null)
  const [owner, setOwner] = useState<OwnerProfile | null>(null)
  const [links, setLinks] = useState<InvitationLink[]>([])
  const [label, setLabel] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [inviteBusy, setInviteBusy] = useState(false)
  const [invitePanelOpen, setInvitePanelOpen] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [conversations, setConversations] = useState<ConversationListItem[]>([])
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [selectedMessages, setSelectedMessages] = useState<MessageRow[]>([])
  const [stats, setStats] = useState<OwnerDashboardStats>({
    totalContacts: 0,
    totalConversations: 0,
    totalMessages: 0,
  })
  const messagesEndRef = useRef<HTMLDivElement | null>(null)

  const firstName = String(user?.user_metadata?.first_name ?? 'Juan').trim()
  const lastName = String(user?.user_metadata?.last_name ?? 'Schubert').trim()
  const phoneNumber = String(user?.phone ?? user?.user_metadata?.phone_number ?? '').trim()
  const userEmail = String(user?.email ?? '').trim()
  const ownerName = owner?.display_name || [owner?.first_name || firstName, owner?.last_name || lastName].filter(Boolean).join(' ') || userEmail || 'Juan Schubert'

  useEffect(() => {
    if (!user) {
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    createOwnerIfNeeded({
      userId: user.id,
      firstName,
      lastName,
      phoneNumber,
      email: userEmail,
    })
      .then(async (ownerRow) => {
        setOwnerId(ownerRow.id)
        setOwner({
          id: ownerRow.id,
          display_name: ownerRow.display_name ?? null,
          first_name: ownerRow.first_name ?? null,
          last_name: ownerRow.last_name ?? null,
          avatar_url: ownerRow.avatar_url ?? null,
        })

        const [conversationResult, linkResult, statsResult] = await Promise.allSettled([
          listConversations(ownerRow.id),
          listInvitationLinks(ownerRow.id),
          getOwnerDashboardStats(ownerRow.id),
        ])
        const conversationData = conversationResult.status === 'fulfilled' ? conversationResult.value : []
        const linkData = linkResult.status === 'fulfilled' ? linkResult.value : []
        const statsData =
          statsResult.status === 'fulfilled'
            ? statsResult.value
            : {
                totalContacts: conversationData.length,
                totalConversations: conversationData.length,
                totalMessages: conversationData.reduce(
                  (total, conversation) => total + conversation.message_count,
                  0
                ),
              }

        if (conversationResult.status === 'rejected') {
          console.error('Conversation list error:', conversationResult.reason)
        }
        if (linkResult.status === 'rejected') {
          console.error('Invitation list error:', linkResult.reason)
        }
        if (statsResult.status === 'rejected') {
          console.error('Dashboard stats error:', statsResult.reason)
        }

        setConversations(conversationData)
        setLinks((linkData as InvitationLink[]) ?? [])
        setStats(statsData)
        setSelectedConversationId((current) => current ?? conversationData[0]?.id ?? null)
      })
      .catch((loadError) => {
        console.error('Dashboard load error:', loadError)
        setError('Unable to load the owner dashboard.')
      })
      .finally(() => setLoading(false))
  }, [firstName, lastName, phoneNumber, userEmail, user])

  useEffect(() => {
    if (!selectedConversationId) {
      setSelectedMessages([])
      return
    }

    setMessagesLoading(true)
    listMessages(selectedConversationId)
      .then((data) => setSelectedMessages(data as MessageRow[]))
      .catch((loadError) => {
        console.error('Conversation load error:', loadError)
        setError('Unable to load this conversation.')
      })
      .finally(() => setMessagesLoading(false))
  }, [selectedConversationId])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [selectedConversationId, selectedMessages])

  const filteredConversations = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return conversations
    return conversations.filter((conversation) => {
      const contact = conversation.wa_contacts
      return [
        getContactName(conversation),
        contact?.email || '',
        conversation.last_message?.content || '',
      ].some((value) => value.toLowerCase().includes(query))
    })
  }, [conversations, search])

  const selectedConversation = useMemo(
    () => filteredConversations.find((conversation) => conversation.id === selectedConversationId)
      ?? conversations.find((conversation) => conversation.id === selectedConversationId)
      ?? null,
    [conversations, filteredConversations, selectedConversationId]
  )

  const avgMessages = stats.totalConversations
    ? Math.round((stats.totalMessages / stats.totalConversations) * 10) / 10
    : 0

  const mostActiveContact = useMemo(() => {
    if (conversations.length === 0) return 'No contact yet'
    return [...conversations]
      .sort((left, right) => right.message_count - left.message_count)[0]
  }, [conversations])

  const selectedInsights = useMemo(() => {
    const contactMessages = selectedMessages.filter((message) => message.sender === 'contact').length
    const avatarMessages = selectedMessages.filter((message) => message.sender === 'avatar').length
    const first = selectedMessages[0]?.created_at
    const last = selectedMessages[selectedMessages.length - 1]?.created_at
    const durationHours =
      first && last
        ? Math.max(0, (new Date(last).getTime() - new Date(first).getTime()) / (1000 * 60 * 60))
        : 0

    return {
      contactMessages,
      avatarMessages,
      durationLabel:
        durationHours >= 24
          ? `${Math.round(durationHours / 24)}d`
          : durationHours >= 1
            ? `${Math.round(durationHours * 10) / 10}h`
            : `${Math.max(1, Math.round(durationHours * 60))}m`,
      topics: summarizeTopics(selectedMessages),
    }
  }, [selectedMessages])

  const handleGenerate = async () => {
    if (!ownerId || inviteBusy) return
    setInviteBusy(true)
    setError(null)
    try {
      const link = await generateInvitationLink(ownerId, label || undefined)
      if (link) {
        setLinks((current) => [link as InvitationLink, ...current])
      } else {
        const refreshed = await listInvitationLinks(ownerId)
        setLinks(refreshed as InvitationLink[])
      }
      setLabel('')
      setInvitePanelOpen(true)
    } catch (inviteError) {
      console.error('Invite generation error:', inviteError)
      setError('Unable to generate an invite link.')
    } finally {
      setInviteBusy(false)
    }
  }

  const handleToggle = async (linkId: string, currentActive: boolean) => {
    try {
      await toggleInvitationLink(linkId, !currentActive)
      setLinks((current) =>
        current.map((link) => (link.id === linkId ? { ...link, active: !currentActive } : link))
      )
    } catch (toggleError) {
      console.error('Invite toggle error:', toggleError)
      setError('Unable to update this invite link.')
    }
  }

  const handleDelete = async (linkId: string) => {
    try {
      await deleteInvitationLink(linkId)
      setLinks((current) => current.filter((link) => link.id !== linkId))
    } catch (deleteError) {
      console.error('Invite delete error:', deleteError)
      setError('Unable to delete this invite link.')
    }
  }

  const copyLink = (token: string, id: string) => {
    navigator.clipboard.writeText(`${window.location.origin}/invite/${token}`)
    setCopiedId(id)
    window.setTimeout(() => setCopiedId(null), 1800)
  }

  const isMobileConversationOpen = Boolean(selectedConversationId)

  if (loading) {
    return (
      <div className="brand-scene flex min-h-screen items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-[#1f2c34] border-t-[#00a884]" />
      </div>
    )
  }

  return (
    <div className="brand-scene min-h-screen px-4 py-4 text-white sm:px-6 sm:py-6">
      <div className="relative z-10 mx-auto flex min-h-[calc(100vh-2rem)] max-w-[1680px] flex-col gap-4 lg:min-h-[calc(100vh-3rem)]">
        <header className="brand-panel rounded-[34px] p-4 sm:p-5">
          <div className="grid gap-4 xl:grid-cols-[1.2fr_2fr_auto] xl:items-center">
            <div className="flex items-center gap-4">
              {owner?.avatar_url ? (
                <img
                  src={owner.avatar_url}
                  alt={ownerName}
                  className="h-16 w-16 rounded-[22px] object-cover shadow-[0_0_28px_rgba(0,168,132,0.25)]"
                />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-[22px] bg-[linear-gradient(135deg,#0e8f74,#153f43)] text-xl font-semibold text-white shadow-[0_0_28px_rgba(0,168,132,0.25)]">
                  {getInitials(ownerName) || 'JS'}
                </div>
              )}
              <div>
                <p className="brand-kicker text-[10px] text-white/38">Owner Console</p>
                <h1 className="mt-2 text-3xl font-bold text-white">{ownerName}</h1>
                <div className="mt-2 flex items-center gap-2 text-sm text-white/58">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#00a884] shadow-[0_0_12px_rgba(0,168,132,0.7)]" />
                  <span>Online</span>
                </div>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-5">
              <div className="brand-inset rounded-[24px] px-4 py-4">
                <p className="text-[11px] uppercase tracking-[0.24em] text-white/40">Contacts</p>
                <p className="mt-3 text-3xl font-semibold text-white">{stats.totalContacts}</p>
              </div>
              <div className="brand-inset rounded-[24px] px-4 py-4">
                <p className="text-[11px] uppercase tracking-[0.24em] text-white/40">Conversations</p>
                <p className="mt-3 text-3xl font-semibold text-white">{stats.totalConversations}</p>
              </div>
              <div className="brand-inset rounded-[24px] px-4 py-4">
                <p className="text-[11px] uppercase tracking-[0.24em] text-white/40">Messages</p>
                <p className="mt-3 text-3xl font-semibold text-white">{stats.totalMessages}</p>
              </div>
              <div className="brand-inset rounded-[24px] px-4 py-4">
                <p className="text-[11px] uppercase tracking-[0.24em] text-white/40">Avg / Conv</p>
                <p className="mt-3 text-3xl font-semibold text-white">{avgMessages}</p>
              </div>
              <div className="brand-inset rounded-[24px] px-4 py-4">
                <p className="text-[11px] uppercase tracking-[0.24em] text-white/40">Most Active</p>
                <p className="mt-3 truncate text-lg font-semibold text-white">
                  {typeof mostActiveContact === 'string' ? mostActiveContact : getContactName(mostActiveContact)}
                </p>
              </div>
            </div>

            <div className="flex gap-3 xl:justify-end">
              <Link
                to="/"
                className="brand-inset rounded-2xl px-4 py-3 text-sm font-medium transition hover:border-[#00a884]/60 hover:text-[#00a884]"
              >
                Home
              </Link>
              <button
                onClick={signOut}
                className="rounded-2xl bg-[#00a884] px-4 py-3 text-sm font-semibold text-[#07141a] transition hover:brightness-110"
              >
                Sign Out
              </button>
            </div>
          </div>
        </header>

        {error ? (
          <div className="rounded-[28px] border border-red-400/20 bg-red-500/10 p-4 text-red-200 backdrop-blur-xl">
            {error}
          </div>
        ) : null}

        <div className="grid flex-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)_320px] xl:max-h-[calc(100vh-280px)]">
          <aside
            className={`brand-panel flex min-h-0 flex-col overflow-hidden rounded-[32px] transition duration-300 ${
              isMobileConversationOpen ? 'hidden xl:flex' : 'flex'
            }`}
          >
            <div className="border-b border-white/8 px-5 pb-4 pt-5">
              <p className="brand-kicker text-[10px] text-white/40">Live Inbox</p>
              <h2 className="mt-2 text-2xl font-semibold text-white">Contacts</h2>
              <p className="mt-2 text-sm text-white/55">Observe every live interaction with the avatar.</p>
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search contacts"
                className="brand-inset mt-4 w-full rounded-2xl px-4 py-3 text-sm text-white placeholder-white/28 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
              />
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-3">
              {filteredConversations.length === 0 ? (
                <div className="brand-inset mx-2 rounded-[24px] border-dashed px-4 py-8 text-center text-sm text-white/58">
                  No conversations found.
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredConversations.map((conversation) => {
                    const active = conversation.id === selectedConversationId
                    const lastActive = conversation.last_message?.created_at || conversation.updated_at
                    return (
                      <button
                        key={conversation.id}
                        type="button"
                        onClick={() => setSelectedConversationId(conversation.id)}
                        className={`w-full rounded-[24px] border px-4 py-4 text-left transition duration-200 ${
                          active
                            ? 'border-[#00a884]/55 bg-[linear-gradient(180deg,rgba(8,55,52,0.88),rgba(7,36,35,0.94))] shadow-[0_16px_40px_rgba(0,0,0,0.22)]'
                            : 'border-white/6 bg-[rgba(8,22,30,0.7)] hover:-translate-y-[1px] hover:border-white/12 hover:bg-[rgba(10,27,37,0.8)]'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className={`h-2.5 w-2.5 rounded-full ${isOnline(lastActive) ? 'bg-[#00a884]' : 'bg-white/22'}`} />
                              <p className="truncate text-sm font-semibold text-white">{getContactName(conversation)}</p>
                            </div>
                            <p className="mt-1 truncate text-xs text-white/46">
                              {conversation.wa_contacts?.email || 'No contact detail'}
                            </p>
                          </div>
                          <div className="shrink-0 text-[11px] text-white/45">{formatTimestamp(lastActive)}</div>
                        </div>
                        <div className="mt-3 flex items-center justify-between gap-3">
                          <p className="min-w-0 flex-1 truncate text-sm text-white/65">
                            {formatMessagePreview(conversation.last_message?.content ?? null, conversation.last_message?.type ?? 'text')}
                          </p>
                          <span className="rounded-full bg-white/7 px-2.5 py-1 text-[11px] text-white/62">
                            {conversation.message_count}
                          </span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="border-t border-white/8 px-4 py-4">
              <button
                type="button"
                onClick={() => setInvitePanelOpen((current) => !current)}
                className="brand-inset flex w-full items-center justify-between rounded-[24px] px-4 py-4 text-left transition hover:border-[#00a884]/45"
              >
                <div>
                  <p className="text-[11px] uppercase tracking-[0.24em] text-white/40">Invites</p>
                  <p className="mt-2 text-lg font-semibold text-white">Invite management</p>
                </div>
                <span className="text-sm text-white/54">{invitePanelOpen ? 'Hide' : 'Show'}</span>
              </button>

              {invitePanelOpen ? (
                <div className="brand-inset mt-3 rounded-[24px] p-4">
                  <div className="flex gap-3">
                    <input
                      type="text"
                      value={label}
                      onChange={(event) => setLabel(event.target.value)}
                      placeholder="Optional invite label"
                      className="brand-inset min-w-0 flex-1 rounded-2xl px-4 py-3 text-sm text-white placeholder-white/28 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                    />
                    <button
                      type="button"
                      onClick={handleGenerate}
                      disabled={inviteBusy}
                      className="rounded-2xl bg-[#00a884] px-4 py-3 text-sm font-semibold text-[#07141a] transition hover:brightness-110 disabled:opacity-60"
                    >
                      {inviteBusy ? 'Generating...' : 'Generate'}
                    </button>
                  </div>
                  <div className="mt-4 max-h-52 space-y-2 overflow-y-auto">
                    {links.length === 0 ? (
                      <div className="rounded-[20px] border border-white/6 bg-black/14 px-3 py-4 text-sm text-white/56">
                        No invite links yet.
                      </div>
                    ) : null}
                    {links.map((link) => (
                      <div key={link.id} className="rounded-[20px] border border-white/6 bg-black/14 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white">{link.label || 'Untitled invite'}</p>
                            <p className="mt-1 text-xs text-white/46">{link.use_count} uses</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleToggle(link.id, link.active)}
                            className={`rounded-full px-3 py-1 text-xs font-medium ${
                              link.active ? 'bg-[#00a884]/18 text-[#7be3ce]' : 'bg-white/8 text-white/60'
                            }`}
                          >
                            {link.active ? 'Active' : 'Inactive'}
                          </button>
                        </div>
                        <div className="mt-3 flex gap-2">
                          <button
                            type="button"
                            onClick={() => copyLink(link.token, link.id)}
                            className="rounded-xl border border-white/10 px-3 py-2 text-xs text-white/78 transition hover:border-[#00a884]/55 hover:text-[#00a884]"
                          >
                            {copiedId === link.id ? 'Copied' : 'Copy Link'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(link.id)}
                            className="rounded-xl border border-red-400/20 px-3 py-2 text-xs text-red-300/70 transition hover:border-red-400/50 hover:text-red-300"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </aside>

          <section
            className={`brand-panel min-h-0 overflow-hidden rounded-[32px] ${
              isMobileConversationOpen ? 'flex' : 'hidden xl:flex'
            } flex-col`}
          >
            {selectedConversation ? (
              <>
                <div className="border-b border-white/8 px-5 py-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex min-w-0 items-center gap-4">
                      <button
                        type="button"
                        onClick={() => setSelectedConversationId(null)}
                        className="brand-inset flex h-11 w-11 items-center justify-center rounded-2xl text-white xl:hidden"
                      >
                        <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19 8 12l7-7" />
                        </svg>
                      </button>
                      <div>
                        <p className="text-xl font-semibold text-white">{getContactName(selectedConversation)}</p>
                        <div className="mt-1 flex items-center gap-2 text-sm text-white/52">
                          <span className={`h-2.5 w-2.5 rounded-full ${isOnline(selectedConversation.last_message?.created_at || selectedConversation.updated_at) ? 'bg-[#00a884]' : 'bg-white/22'}`} />
                          <span>
                            {selectedConversation.wa_contacts?.email || 'No contact detail'}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="hidden text-right lg:block">
                      <p className="text-xs uppercase tracking-[0.24em] text-white/38">Observer Mode</p>
                      <p className="mt-2 text-sm text-white/58">The avatar handles replies automatically</p>
                    </div>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
                  {messagesLoading ? (
                    <div className="flex h-full items-center justify-center">
                      <div className="h-9 w-9 animate-spin rounded-full border-4 border-[#1f2c34] border-t-[#00a884]" />
                    </div>
                  ) : selectedMessages.length === 0 ? (
                    <div className="brand-inset rounded-[24px] border-dashed px-4 py-8 text-center text-white/58">
                      No messages in this conversation yet.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {selectedMessages.map((message) => {
                        const isContactMessage = message.sender === 'contact'
                        return (
                          <div key={message.id} className={`flex ${isContactMessage ? 'justify-start' : 'justify-end'}`}>
                            <div
                              className={`max-w-[90%] rounded-[26px] border px-4 py-3 shadow-[0_18px_50px_rgba(0,0,0,0.18)] ${
                                isContactMessage
                                  ? 'rounded-tl-md border-white/8 bg-[linear-gradient(180deg,rgba(22,34,51,0.9),rgba(12,24,39,0.95))]'
                                  : 'rounded-tr-md border-[#00a884]/20 bg-[linear-gradient(180deg,rgba(8,118,100,0.88),rgba(5,86,79,0.94))]'
                              }`}
                            >
                              <p className="mb-2 text-[11px] uppercase tracking-[0.2em] text-white/42">
                                {isContactMessage ? 'Contact' : 'Avatar'}
                              </p>
                              {message.media_url && message.type === 'image' ? (
                                <img src={message.media_url} alt="Shared media" className="max-h-80 rounded-[18px] object-cover" />
                              ) : null}
                              {message.media_url && message.type === 'video' ? (
                                <video src={message.media_url} controls playsInline className="max-h-96 rounded-[18px]" />
                              ) : null}
                              {message.media_url && message.type === 'voice' ? (
                                <audio src={message.media_url} controls className="w-full min-w-[240px]" />
                              ) : null}
                              <p className={`whitespace-pre-wrap text-sm leading-6 text-white ${message.media_url ? 'mt-3' : ''}`}>
                                {formatMessagePreview(message.content, message.type)}
                              </p>
                              <div className="mt-3 flex items-center justify-between gap-4 text-[11px] text-white/42">
                                <span className="capitalize">{message.type}</span>
                                <span>{formatMessageTime(message.created_at)}</span>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                      <div ref={messagesEndRef} />
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex h-full flex-1 items-center justify-center px-6">
                <div className="max-w-md text-center">
                  <img
                    src="/Icon.PNG"
                    alt="WhatsAnima"
                    className="mx-auto h-20 w-20 rounded-[24px] object-cover shadow-[0_0_34px_rgba(0,168,132,0.24)]"
                  />
                  <h2 className="mt-6 text-3xl font-semibold text-white">Select a conversation</h2>
                  <p className="mt-3 text-sm leading-7 text-white/58">
                    Review every interaction, message flow, and media exchange from one premium owner console.
                  </p>
                </div>
              </div>
            )}
          </section>

          <aside className="brand-panel flex min-h-0 flex-col overflow-hidden rounded-[32px]">
            <div className="border-b border-white/8 px-5 pb-4 pt-5">
              <p className="brand-kicker text-[10px] text-white/40">Insights</p>
              <h2 className="mt-2 text-2xl font-semibold text-white">Conversation intelligence</h2>
              <p className="mt-2 text-sm text-white/55">Operational visibility for tomorrow’s presentation.</p>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-4">
              {selectedConversation ? (
                <div className="space-y-4">
                  <div className="brand-inset rounded-[24px] p-4">
                    <p className="text-[11px] uppercase tracking-[0.24em] text-white/40">Summary</p>
                    <p className="mt-3 text-sm leading-7 text-white/72">
                      {selectedInsights.topics.length > 0
                        ? `Main topics: ${selectedInsights.topics.join(', ')}.`
                        : 'Topic extraction will become richer as more conversation data accumulates.'}
                    </p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                    <div className="brand-inset rounded-[24px] p-4">
                      <p className="text-[11px] uppercase tracking-[0.24em] text-white/40">Breakdown</p>
                      <div className="mt-4 space-y-3 text-sm text-white/72">
                        <div className="flex items-center justify-between">
                          <span>Contact messages</span>
                          <span className="font-semibold text-white">{selectedInsights.contactMessages}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>Avatar replies</span>
                          <span className="font-semibold text-white">{selectedInsights.avatarMessages}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>Conversation duration</span>
                          <span className="font-semibold text-white">{selectedInsights.durationLabel}</span>
                        </div>
                      </div>
                    </div>

                    <div className="brand-inset rounded-[24px] p-4">
                      <p className="text-[11px] uppercase tracking-[0.24em] text-white/40">Perception Preview</p>
                      <div className="mt-4 rounded-[20px] border border-white/6 bg-black/14 p-4">
                        <div className="mb-3 h-2 w-24 rounded-full bg-[#00a884]/45" />
                        <div className="space-y-2">
                          <div className="h-2 rounded-full bg-white/10" />
                          <div className="h-2 w-5/6 rounded-full bg-white/10" />
                          <div className="h-2 w-2/3 rounded-full bg-white/10" />
                        </div>
                        <p className="mt-4 text-sm text-white/62">Perception analysis coming soon</p>
                      </div>
                    </div>
                  </div>

                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-center text-sm text-white/56">
                  Select a conversation to reveal the intelligence panel.
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
