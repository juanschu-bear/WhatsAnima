import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import {
  createOwnerIfNeeded,
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

function formatTimestamp(dateStr?: string | null) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function formatLastPreview(conversation: ConversationListItem) {
  const message = conversation.last_message
  if (!message) return 'No messages yet'
  if (message.content?.trim()) return message.content
  return {
    voice: 'Voice message',
    video: 'Video message',
    image: 'Image',
    text: 'Message',
  }[message.type]
}

function formatMessagePreview(message: MessageRow) {
  if (message.content?.trim()) return message.content
  return {
    voice: 'Voice message',
    video: 'Video message',
    image: 'Image',
    text: 'Message',
  }[message.type]
}

function formatContactName(conversation: ConversationListItem) {
  const contact = conversation.wa_contacts
  const fullName = [contact?.first_name, contact?.last_name].filter(Boolean).join(' ').trim()
  return fullName || contact?.display_name || contact?.phone_number || contact?.email || 'Guest'
}

function formatMessageTime(dateStr: string) {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function Dashboard() {
  const { user, signOut } = useAuth()
  const [ownerId, setOwnerId] = useState<string | null>(null)
  const [ownerDisplay, setOwnerDisplay] = useState('Owner')
  const [links, setLinks] = useState<InvitationLink[]>([])
  const [label, setLabel] = useState('')
  const [loading, setLoading] = useState(true)
  const [messagesLoading, setMessagesLoading] = useState(false)
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

  const firstName = String(user?.user_metadata?.first_name ?? '').trim()
  const lastName = String(user?.user_metadata?.last_name ?? '').trim()
  const phoneNumber = String(user?.phone ?? user?.user_metadata?.phone_number ?? '').trim()
  const displayName = [firstName, lastName].filter(Boolean).join(' ') || phoneNumber || 'Owner'

  useEffect(() => {
    if (!user) {
      setLoading(false)
      return
    }

    setLoading(true)
    createOwnerIfNeeded({
      userId: user.id,
      firstName: firstName || 'Owner',
      lastName,
      phoneNumber,
    })
      .then(async (owner) => {
        setOwnerId(owner.id)
        setOwnerDisplay(owner.display_name || displayName)
        const [conversationData, linkData, statsData] = await Promise.all([
          listConversations(owner.id),
          listInvitationLinks(owner.id),
          getOwnerDashboardStats(owner.id),
        ])
        setConversations(conversationData)
        setLinks(linkData as InvitationLink[])
        setStats(statsData)
        setSelectedConversationId((current) => current ?? conversationData[0]?.id ?? null)
        setError(null)
      })
      .catch((err) => {
        console.error('Dashboard load error:', err)
        setError('Unable to load the owner dashboard.')
      })
      .finally(() => setLoading(false))
  }, [displayName, firstName, lastName, phoneNumber, user])

  useEffect(() => {
    if (!selectedConversationId) {
      setSelectedMessages([])
      return
    }

    setMessagesLoading(true)
    listMessages(selectedConversationId)
      .then((data) => {
        setSelectedMessages(data as MessageRow[])
      })
      .catch((err) => {
        console.error('Conversation load error:', err)
        setError('Unable to load this conversation.')
      })
      .finally(() => setMessagesLoading(false))
  }, [selectedConversationId])

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId]
  )

  const unreadConversationIds = useMemo(() => {
    return new Set(
      conversations
        .filter((conversation) => conversation.last_message?.sender === 'contact')
        .map((conversation) => conversation.id)
    )
  }, [conversations])

  const handleGenerate = async () => {
    if (!ownerId) return
    const link = await generateInvitationLink(ownerId, label || undefined)
    setLinks((current) => [link as InvitationLink, ...current])
    setLabel('')
  }

  const handleToggle = async (linkId: string, currentActive: boolean) => {
    await toggleInvitationLink(linkId, !currentActive)
    setLinks((current) =>
      current.map((link) => (link.id === linkId ? { ...link, active: !currentActive } : link))
    )
  }

  const copyLink = (token: string, id: string) => {
    const url = `${window.location.origin}/invite/${token}`
    navigator.clipboard.writeText(url)
    setCopiedId(id)
    window.setTimeout(() => setCopiedId(null), 2000)
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
      <div className="relative z-10 mx-auto flex min-h-[calc(100vh-2rem)] max-w-[1540px] flex-col gap-4 lg:min-h-[calc(100vh-3rem)]">
        <header className="brand-panel grid gap-4 rounded-[32px] p-4 lg:grid-cols-[1.1fr_1.9fr_auto] lg:items-center lg:p-5">
          <div className="flex items-center gap-4">
            <img
              src="/Icon.PNG"
              alt="WhatsAnima"
              className="h-12 w-12 rounded-[16px] object-cover shadow-[0_0_24px_rgba(0,168,132,0.22)]"
            />
            <div>
              <p className="brand-kicker text-[10px] text-white/40">Owner Console</p>
              <h1 className="mt-1 text-2xl font-bold text-white">Dashboard</h1>
              <p className="mt-1 text-sm text-white/58">{ownerDisplay}</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
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
          </div>

          <div className="flex gap-3 lg:justify-end">
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
        </header>

        {error ? (
          <div className="rounded-[28px] border border-red-400/20 bg-red-500/10 p-4 text-red-200 backdrop-blur-xl">
            {error}
          </div>
        ) : null}

        <div className="grid flex-1 gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <aside
            className={`brand-panel flex min-h-[720px] flex-col overflow-hidden rounded-[32px] ${
              isMobileConversationOpen ? 'hidden lg:flex' : 'flex'
            }`}
          >
            <div className="border-b border-white/8 px-5 pb-4 pt-5">
              <p className="brand-kicker text-[10px] text-white/40">Live Inbox</p>
              <h2 className="mt-2 text-2xl font-semibold text-white">Contacts</h2>
              <p className="mt-2 text-sm text-white/55">Observe every conversation with your avatar.</p>
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-3">
              {conversations.length === 0 ? (
                <div className="brand-inset mx-2 rounded-[24px] border-dashed px-4 py-8 text-center text-sm text-white/58">
                  No conversations yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {conversations.map((conversation) => {
                    const active = conversation.id === selectedConversationId
                    const unread = unreadConversationIds.has(conversation.id)
                    return (
                      <button
                        key={conversation.id}
                        type="button"
                        onClick={() => setSelectedConversationId(conversation.id)}
                        className={`w-full rounded-[24px] border px-4 py-4 text-left transition ${
                          active
                            ? 'border-[#00a884]/55 bg-[linear-gradient(180deg,rgba(8,55,52,0.88),rgba(7,36,35,0.94))] shadow-[0_16px_40px_rgba(0,0,0,0.22)]'
                            : 'border-white/6 bg-[rgba(8,22,30,0.7)] hover:border-white/12 hover:bg-[rgba(10,27,37,0.8)]'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-white">
                              {formatContactName(conversation)}
                            </p>
                            <p className="mt-1 truncate text-xs text-white/46">
                              {conversation.wa_contacts?.phone_number || conversation.wa_contacts?.email || 'No contact detail'}
                            </p>
                          </div>
                          <div className="shrink-0 text-[11px] text-white/45">
                            {formatTimestamp(conversation.last_message?.created_at || conversation.updated_at)}
                          </div>
                        </div>
                        <div className="mt-3 flex items-center gap-3">
                          <p className="min-w-0 flex-1 truncate text-sm text-white/65">
                            {formatLastPreview(conversation)}
                          </p>
                          {unread ? <span className="h-2.5 w-2.5 rounded-full bg-[#00a884]" /> : null}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="border-t border-white/8 px-4 py-4">
              <div className="brand-inset rounded-[28px] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="brand-kicker text-[10px] text-white/40">Invites</p>
                    <h3 className="mt-2 text-lg font-semibold text-white">Link management</h3>
                  </div>
                  <button
                    onClick={handleGenerate}
                    className="rounded-2xl bg-[#00a884] px-4 py-2.5 text-sm font-semibold text-[#07141a] transition hover:brightness-110"
                  >
                    Generate
                  </button>
                </div>
                <input
                  type="text"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="Optional invite label"
                  className="brand-inset mt-4 w-full rounded-2xl px-4 py-3 text-sm text-white placeholder-white/28 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                />
                <div className="mt-4 space-y-2">
                  {links.slice(0, 4).map((link) => (
                    <div key={link.id} className="rounded-[20px] border border-white/6 bg-black/14 px-3 py-3">
                      <div className="flex items-center justify-between gap-3">
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
                          {copiedId === link.id ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </aside>

          <section
            className={`brand-panel min-h-[720px] overflow-hidden rounded-[32px] ${
              isMobileConversationOpen ? 'flex' : 'hidden lg:flex'
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
                        className="brand-inset flex h-11 w-11 items-center justify-center rounded-2xl text-white lg:hidden"
                      >
                        <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19 8 12l7-7" />
                        </svg>
                      </button>
                      <div className="min-w-0">
                        <p className="text-xl font-semibold text-white">{formatContactName(selectedConversation)}</p>
                        <p className="mt-1 truncate text-sm text-white/52">
                          {selectedConversation.wa_contacts?.phone_number ||
                            selectedConversation.wa_contacts?.email ||
                            'No contact detail'}
                        </p>
                      </div>
                    </div>
                    <div className="hidden text-right lg:block">
                      <p className="text-xs uppercase tracking-[0.24em] text-white/38">Observing</p>
                      <p className="mt-2 text-sm text-white/58">Avatar handles replies automatically</p>
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
                        const isContact = message.sender === 'contact'
                        return (
                          <div
                            key={message.id}
                            className={`flex ${isContact ? 'justify-start' : 'justify-end'}`}
                          >
                            <div
                              className={`max-w-[88%] rounded-[26px] border px-4 py-3 shadow-[0_18px_50px_rgba(0,0,0,0.18)] ${
                                isContact
                                  ? 'rounded-tl-md border-white/8 bg-[linear-gradient(180deg,rgba(22,34,51,0.9),rgba(12,24,39,0.95))]'
                                  : 'rounded-tr-md border-[#00a884]/20 bg-[linear-gradient(180deg,rgba(8,118,100,0.88),rgba(5,86,79,0.94))]'
                              }`}
                            >
                              <p className="mb-2 text-[11px] uppercase tracking-[0.2em] text-white/42">
                                {isContact ? 'Contact' : 'Avatar'}
                              </p>

                              {message.media_url ? (
                                <>
                                  {message.type === 'image' ? (
                                    <img
                                      src={message.media_url}
                                      alt="Shared media"
                                      className="max-h-80 rounded-[18px] object-cover"
                                    />
                                  ) : null}
                                  {message.type === 'video' ? (
                                    <video
                                      src={message.media_url}
                                      controls
                                      playsInline
                                      className="max-h-96 rounded-[18px]"
                                    />
                                  ) : null}
                                  {message.type === 'voice' ? (
                                    <audio src={message.media_url} controls className="w-full min-w-[240px]" />
                                  ) : null}
                                </>
                              ) : null}

                              <p
                                className={`whitespace-pre-wrap text-sm leading-6 text-white ${
                                  message.media_url ? 'mt-3' : ''
                                }`}
                              >
                                {formatMessagePreview(message)}
                              </p>

                              <div className="mt-3 flex items-center justify-between gap-4 text-[11px] text-white/42">
                                <span className="capitalize">{message.type}</span>
                                <span>{formatMessageTime(message.created_at)}</span>
                              </div>
                            </div>
                          </div>
                        )
                      })}
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
                    Review every customer interaction, message flow, and media exchange from one premium owner console.
                  </p>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
