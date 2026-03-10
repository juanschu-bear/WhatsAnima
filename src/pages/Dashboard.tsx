import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import {
  createOwnerIfNeeded,
  deleteInvitationLink,
  generateInvitationLink,
  getOwnerDashboardStats,
  listAllOwners,
  listConversations,
  listInvitationLinks,
  listMessages,
  toggleInvitationLink,
  type ConversationListItem,
  type MessageType,
  type OwnerDashboardStats,
} from '../lib/api'
import { resolveAvatarUrl } from '../lib/avatars'
import { type Locale, getStoredLocale, setStoredLocale, t } from '../lib/i18n'

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

function isOnline(dateStr?: string | null) {
  if (!dateStr) return false
  return Date.now() - new Date(dateStr).getTime() < 5 * 60 * 1000
}

function computeConversationInsights(messages: MessageRow[], locale: Locale) {
  const contactMsgs = messages.filter((m) => m.sender === 'contact')
  const avatarMsgs = messages.filter((m) => m.sender === 'avatar')
  const total = messages.length

  const voiceCount = messages.filter((m) => m.type === 'voice').length
  const textCount = messages.filter((m) => m.type === 'text').length
  const imageCount = messages.filter((m) => m.type === 'image').length
  const videoCount = messages.filter((m) => m.type === 'video').length

  const totalVoiceSec = messages.reduce((sum, m) => sum + (m.duration_sec ?? 0), 0)
  const voiceMinutes = Math.round(totalVoiceSec / 60 * 10) / 10

  const first = messages[0]?.created_at
  const last = messages[messages.length - 1]?.created_at
  const durationMs = first && last ? Math.max(0, new Date(last).getTime() - new Date(first).getTime()) : 0
  const durationHours = durationMs / (1000 * 60 * 60)
  const durationLabel = durationHours >= 24
    ? `${Math.round(durationHours / 24)}d`
    : durationHours >= 1 ? `${Math.round(durationHours * 10) / 10}h` : `${Math.max(1, Math.round(durationHours * 60))}m`

  let totalResponseMs = 0
  let responseCount = 0
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].sender === 'avatar' && messages[i - 1].sender === 'contact') {
      const diff = new Date(messages[i].created_at).getTime() - new Date(messages[i - 1].created_at).getTime()
      if (diff > 0 && diff < 24 * 60 * 60 * 1000) { totalResponseMs += diff; responseCount++ }
    }
  }
  const avgResponseSec = responseCount > 0 ? Math.round(totalResponseMs / responseCount / 1000) : 0
  const avgResponseLabel = avgResponseSec < 60 ? `${avgResponseSec}s`
    : avgResponseSec < 3600 ? `${Math.floor(avgResponseSec / 60)}m ${avgResponseSec % 60}s` : `${Math.round(avgResponseSec / 3600)}h`

  const engagementPct = total > 0 ? Math.round((contactMsgs.length / total) * 100) : 0

  const contactTexts = contactMsgs.filter((m) => m.content?.trim()).map((m) => m.content!.trim())
  const avgMsgLen = contactTexts.length > 0
    ? Math.round(contactTexts.reduce((s, t) => s + t.length, 0) / contactTexts.length)
    : 0

  const allText = messages.map((m) => m.content || '').join(' ').toLowerCase()
  const deScore = (allText.match(/\b(ich|und|der|die|das|nicht|auch|wenn|aber|oder|noch|schon|kann|habe|wird|haben|wir|sie|mir|mein)\b/g) ?? []).length
  const esScore = (allText.match(/\b(que|para|con|los|las|una|pero|como|por|esta|este|todo|mas|muy|bien|hola|tengo|puede|hacer|donde)\b/g) ?? []).length
  const enScore = (allText.match(/\b(the|and|you|that|have|for|with|this|your|from|are|was|but|not|can|just|will|what|when|would|know)\b/g) ?? []).length
  const langs = [
    { lang: locale === 'es' ? 'Ingles' : 'English', s: enScore },
    { lang: locale === 'es' ? 'Aleman' : 'German', s: deScore },
    { lang: locale === 'es' ? 'Espanol' : 'Spanish', s: esScore },
  ].filter((l) => l.s > 0).sort((a, b) => b.s - a.s)
  const language = langs.length > 1
    ? `${langs[0].lang} / ${langs[1].lang}`
    : langs[0]?.lang || (locale === 'es' ? 'No detectado' : 'Not detected')

  const hourBuckets = new Map<number, number>()
  for (const m of messages) { const h = new Date(m.created_at).getHours(); hourBuckets.set(h, (hourBuckets.get(h) ?? 0) + 1) }
  const peakEntry = [...hourBuckets.entries()].sort((a, b) => b[1] - a[1])[0]
  const peakTime = peakEntry ? `${String(peakEntry[0]).padStart(2, '0')}:00` : '--'

  const en = locale !== 'es'
  const qCount = (allText.match(/\?/g) ?? []).length
  const exCount = (allText.match(/!/g) ?? []).length
  const emojiCount = (allText.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}]/gu) ?? []).length

  // Behavioral signals with icon + description
  const signals: { label: string; icon: string; desc: string; color: string }[] = []
  if (qCount > 1) signals.push({
    label: en ? 'Curious' : 'Curioso',
    icon: '?',
    desc: en ? `${qCount} questions asked \u2014 actively seeking information` : `${qCount} preguntas \u2014 busca informacion activamente`,
    color: '#53d0ff',
  })
  if (exCount > 1) signals.push({
    label: en ? 'Energetic' : 'Energetico',
    icon: '!',
    desc: en ? `${exCount} exclamations \u2014 high emotional involvement` : `${exCount} exclamaciones \u2014 alta implicacion emocional`,
    color: '#f59e0b',
  })
  if (emojiCount > 0) signals.push({
    label: en ? 'Expressive' : 'Expresivo',
    icon: '\u{1F60A}',
    desc: en ? `Uses emojis (${emojiCount}x) \u2014 communicates with emotional nuance` : `Usa emojis (${emojiCount}x) \u2014 comunica con matiz emocional`,
    color: '#f472b6',
  })
  if (voiceCount > textCount && voiceCount > 0) signals.push({
    label: en ? 'Voice-first' : 'Prefiere voz',
    icon: '\u{1F3A4}',
    desc: en ? `${voiceCount} voice vs ${textCount} text \u2014 prefers speaking over typing` : `${voiceCount} voz vs ${textCount} texto \u2014 prefiere hablar`,
    color: '#a78bfa',
  })
  if (imageCount + videoCount > 0) signals.push({
    label: 'Visual',
    icon: '\u{1F4F7}',
    desc: en ? `${imageCount + videoCount} media shared \u2014 visually expressive` : `${imageCount + videoCount} medios compartidos \u2014 comunicador visual`,
    color: '#34d399',
  })
  if (avgMsgLen > 100) signals.push({
    label: en ? 'Detailed' : 'Detallista',
    icon: '\u{1F4DD}',
    desc: en ? `Avg. ${avgMsgLen} chars/msg \u2014 thorough, detailed responses` : `Prom. ${avgMsgLen} car./msg \u2014 respuestas detalladas`,
    color: '#60a5fa',
  })
  if (avgMsgLen > 0 && avgMsgLen <= 30) signals.push({
    label: en ? 'Concise' : 'Conciso',
    icon: '\u{26A1}',
    desc: en ? `Avg. ${avgMsgLen} chars/msg \u2014 direct and to the point` : `Prom. ${avgMsgLen} car./msg \u2014 directo al punto`,
    color: '#fbbf24',
  })
  if (signals.length === 0) signals.push({
    label: en ? 'Neutral' : 'Neutral',
    icon: '\u{1F4AC}',
    desc: en ? 'Balanced style \u2014 no strong patterns detected yet' : 'Estilo equilibrado \u2014 sin patrones fuertes aun',
    color: '#94a3b8',
  })

  // Media breakdown
  const mediaBreakdown = [
    { label: en ? 'Text' : 'Texto', count: textCount, color: '#00a884' },
    { label: en ? 'Voice' : 'Voz', count: voiceCount, color: '#53d0ff' },
    { label: en ? 'Image' : 'Imagen', count: imageCount, color: '#a78bfa' },
    { label: 'Video', count: videoCount, color: '#f472b6' },
  ].filter((b) => b.count > 0)
  const maxMedia = Math.max(1, ...mediaBreakdown.map((b) => b.count))

  // Strengths & Weaknesses
  const strengths: { label: string; detail: string }[] = []
  const weaknesses: { label: string; detail: string }[] = []

  if (avgResponseSec > 0 && avgResponseSec < 30) strengths.push({
    label: en ? 'Lightning-fast responses' : 'Respuestas ultrarapidas',
    detail: en ? `Avatar responds in ${avgResponseLabel} on average` : `El avatar responde en ${avgResponseLabel} de media`,
  })
  else if (avgResponseSec >= 30) weaknesses.push({
    label: en ? 'Response time could improve' : 'Tiempo de respuesta mejorable',
    detail: en ? `${avgResponseLabel} avg \u2014 consider optimizing` : `${avgResponseLabel} prom. \u2014 considerar optimizar`,
  })

  if (engagementPct >= 40 && engagementPct <= 65) strengths.push({
    label: en ? 'Balanced dialogue' : 'Dialogo equilibrado',
    detail: en ? `${engagementPct}% contact-initiated \u2014 healthy back-and-forth` : `${engagementPct}% iniciado por contacto \u2014 dinamica saludable`,
  })
  else if (engagementPct > 75) weaknesses.push({
    label: en ? 'One-sided conversation' : 'Conversacion unilateral',
    detail: en ? `${engagementPct}% contact-initiated \u2014 avatar needs more proactivity` : `${engagementPct}% del contacto \u2014 el avatar necesita mas proactividad`,
  })
  else if (engagementPct < 25 && total > 2) weaknesses.push({
    label: en ? 'Low contact engagement' : 'Baja participacion',
    detail: en ? `Only ${engagementPct}% from contact \u2014 may indicate low interest` : `Solo ${engagementPct}% del contacto \u2014 puede indicar bajo interes`,
  })

  if (voiceCount > 0 && textCount > 0) strengths.push({
    label: en ? 'Multi-modal interaction' : 'Interaccion multimodal',
    detail: en ? 'Uses both voice and text \u2014 rich communication' : 'Usa voz y texto \u2014 comunicacion rica',
  })

  if (total >= 5 && durationHours > 0) strengths.push({
    label: en ? 'Active conversation' : 'Conversacion activa',
    detail: en ? `${total} messages over ${durationLabel} \u2014 sustained engagement` : `${total} mensajes en ${durationLabel} \u2014 compromiso sostenido`,
  })
  else if (total <= 2) weaknesses.push({
    label: en ? 'Early stage' : 'Fase inicial',
    detail: en ? 'Very few messages \u2014 conversation just getting started' : 'Pocos mensajes \u2014 la conversacion recien comienza',
  })

  // Recommendations
  const recommendations: { text: string; priority: 'high' | 'medium' | 'low' }[] = []
  if (total <= 2) recommendations.push({
    text: en ? 'Send a follow-up to re-engage and keep momentum' : 'Enviar seguimiento para reactivar al contacto',
    priority: 'high',
  })
  if (engagementPct > 75) recommendations.push({
    text: en ? 'Adjust avatar to be more proactive and conversational' : 'Ajustar avatar para ser mas proactivo y conversacional',
    priority: 'high',
  })
  if (voiceCount > textCount * 2 && voiceCount > 0) recommendations.push({
    text: en ? 'Contact prefers voice \u2014 consider voice-optimized strategies' : 'El contacto prefiere voz \u2014 optimizar estrategia de respuesta',
    priority: 'medium',
  })
  if (avgMsgLen > 150) recommendations.push({
    text: en ? 'Contact writes long messages \u2014 match depth in replies' : 'Mensajes largos del contacto \u2014 igualar profundidad en respuestas',
    priority: 'medium',
  })
  if (qCount > 2) recommendations.push({
    text: en ? 'High question frequency \u2014 ensure thorough answers' : 'Alta frecuencia de preguntas \u2014 asegurar respuestas completas',
    priority: 'medium',
  })
  if (recommendations.length === 0) recommendations.push({
    text: en ? 'Conversation progressing well \u2014 no urgent actions needed' : 'Conversacion progresa bien \u2014 sin acciones urgentes',
    priority: 'low',
  })

  return {
    contactMessages: contactMsgs.length,
    avatarMessages: avatarMsgs.length,
    total,
    durationLabel,
    voiceMinutes,
    avgResponseLabel,
    avgResponseSec,
    engagementPct,
    avgMsgLen,
    language,
    peakTime,
    signals,
    mediaBreakdown,
    maxMedia,
    strengths,
    weaknesses,
    recommendations,
  }
}

export default function Dashboard() {
  const { user, signOut } = useAuth()
  const [locale, setLocale] = useState<Locale>(getStoredLocale)
  const [ownerId, setOwnerId] = useState<string | null>(null)
  const [owner, setOwner] = useState<OwnerProfile | null>(null)
  const [allOwners, setAllOwners] = useState<OwnerProfile[]>([])
  const [ownerSwitcherOpen, setOwnerSwitcherOpen] = useState(false)
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

  const L = useCallback((key: Parameters<typeof t>[1]) => t(locale, key), [locale])

  const toggleLocale = () => {
    const next: Locale = locale === 'en' ? 'es' : 'en'
    setLocale(next)
    setStoredLocale(next)
  }

  const userEmail = String(user?.email ?? '').trim()
  const ownerName = owner?.display_name || userEmail || 'Owner'

  // Load the authenticated user's owner + all owners for the switcher
  useEffect(() => {
    if (!user) {
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)

    Promise.all([
      createOwnerIfNeeded({ userId: user.id, email: userEmail }),
      listAllOwners(),
    ])
      .then(async ([ownerRow, owners]) => {
        setOwnerId(ownerRow.id)
        setOwner({
          id: ownerRow.id,
          display_name: ownerRow.display_name ?? null,
        })
        setAllOwners(
          (owners as OwnerProfile[]).length > 0
            ? (owners as OwnerProfile[])
            : [{ id: ownerRow.id, display_name: ownerRow.display_name ?? null }]
        )

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
        console.error('Dashboard load error:', loadError?.message ?? loadError?.code ?? loadError)
        setError(`Unable to load the owner dashboard: ${loadError?.message || 'unknown error'}`)
      })
      .finally(() => setLoading(false))
  }, [userEmail, user])

  // Switch owner view — reload conversations/stats for a different owner
  const switchToOwner = useCallback(async (targetOwner: OwnerProfile) => {
    setOwnerSwitcherOpen(false)
    if (targetOwner.id === ownerId) return

    setOwnerId(targetOwner.id)
    setOwner(targetOwner)
    setConversations([])
    setSelectedConversationId(null)
    setSelectedMessages([])
    setLinks([])
    setStats({ totalContacts: 0, totalConversations: 0, totalMessages: 0 })
    setMessagesLoading(false)
    setError(null)

    try {
      const [conversationResult, linkResult, statsResult] = await Promise.allSettled([
        listConversations(targetOwner.id),
        listInvitationLinks(targetOwner.id),
        getOwnerDashboardStats(targetOwner.id),
      ])

      const conversationData = conversationResult.status === 'fulfilled' ? conversationResult.value : []
      const linkData = linkResult.status === 'fulfilled' ? linkResult.value : []
      const statsData =
        statsResult.status === 'fulfilled'
          ? statsResult.value
          : {
              totalContacts: conversationData.length,
              totalConversations: conversationData.length,
              totalMessages: conversationData.reduce((total, c) => total + c.message_count, 0),
            }

      setConversations(conversationData)
      setLinks((linkData as InvitationLink[]) ?? [])
      setStats(statsData)
      setSelectedConversationId(conversationData[0]?.id ?? null)
    } catch (err) {
      console.error('Owner switch error:', err)
      setError(`Failed to load data for ${targetOwner.display_name || 'owner'}`)
    }
  }, [ownerId])

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
    if (conversations.length === 0) return L('noContactYet')
    return [...conversations]
      .sort((left, right) => right.message_count - left.message_count)[0]
  }, [conversations, L])

  const selectedInsights = useMemo(
    () => computeConversationInsights(selectedMessages, locale),
    [selectedMessages, locale]
  )

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
    <div className="brand-scene h-screen overflow-hidden px-4 py-4 text-white sm:px-6 sm:py-6">
      <div className="relative z-10 mx-auto flex h-full max-w-[1680px] flex-col gap-4">
        <header className="brand-panel rounded-[34px] p-4 sm:p-5">
          <div className="grid gap-4 xl:grid-cols-[1.2fr_2fr_auto] xl:items-center">
            <div className="flex items-center gap-4">
              <div className="relative">
                <img
                  src={resolveAvatarUrl(ownerName)}
                  alt={ownerName}
                  className="h-16 w-16 rounded-[22px] object-cover shadow-[0_0_28px_rgba(0,168,132,0.25)]"
                />
                {/* Owner switcher dropdown trigger */}
                {allOwners.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => setOwnerSwitcherOpen((v) => !v)}
                    title={L('switchOwner')}
                    className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full border border-white/15 bg-[#0b141a] text-[10px] text-white/70 transition hover:border-[#00a884]/60 hover:text-[#00a884]"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4-4 4 4m0 6l-4 4-4-4" />
                    </svg>
                  </button>
                ) : null}
                {/* Owner switcher dropdown */}
                {ownerSwitcherOpen && allOwners.length > 1 ? (
                  <div className="absolute left-0 top-full z-50 mt-2 w-64 rounded-[20px] border border-white/10 bg-[#0b1a22] p-2 shadow-[0_20px_60px_rgba(0,0,0,0.5)]">
                    <p className="px-3 py-2 text-[10px] uppercase tracking-[0.24em] text-white/40">{L('allOwners')}</p>
                    {allOwners.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => switchToOwner(o)}
                        className={`flex w-full items-center gap-3 rounded-[14px] px-3 py-3 text-left transition ${
                          o.id === ownerId
                            ? 'border border-[#00a884]/40 bg-[#00a884]/10 text-[#00a884]'
                            : 'border border-transparent text-white hover:bg-white/5'
                        }`}
                      >
                        <img
                          src={resolveAvatarUrl(o.display_name)}
                          alt={o.display_name || 'Owner'}
                          className="h-9 w-9 shrink-0 rounded-full object-cover"
                        />
                        <span className="truncate text-sm font-medium">{o.display_name || 'Unnamed'}</span>
                        {o.id === ownerId ? (
                          <svg className="ml-auto h-4 w-4 shrink-0 text-[#00a884]" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <div>
                <p className="brand-kicker text-[10px] text-white/38">{L('ownerConsole')}</p>
                <h1 className="mt-2 text-3xl font-bold text-white">{ownerName}</h1>
                <div className="mt-2 flex items-center gap-2 text-sm text-white/58">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#00a884] shadow-[0_0_12px_rgba(0,168,132,0.7)]" />
                  <span>{L('online')}</span>
                </div>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-5">
              <div className="brand-inset rounded-[24px] px-4 py-4">
                <p className="text-[11px] uppercase tracking-[0.24em] text-white/40">{L('contacts')}</p>
                <p className="mt-3 text-3xl font-semibold text-white">{stats.totalContacts}</p>
              </div>
              <div className="brand-inset rounded-[24px] px-4 py-4">
                <p className="text-[11px] uppercase tracking-[0.24em] text-white/40">{L('conversations')}</p>
                <p className="mt-3 text-3xl font-semibold text-white">{stats.totalConversations}</p>
              </div>
              <div className="brand-inset rounded-[24px] px-4 py-4">
                <p className="text-[11px] uppercase tracking-[0.24em] text-white/40">{L('messages')}</p>
                <p className="mt-3 text-3xl font-semibold text-white">{stats.totalMessages}</p>
              </div>
              <div className="brand-inset rounded-[24px] px-4 py-4">
                <p className="text-[11px] uppercase tracking-[0.24em] text-white/40">{L('avgPerConv')}</p>
                <p className="mt-3 text-3xl font-semibold text-white">{avgMessages}</p>
              </div>
              <div className="brand-inset rounded-[24px] px-4 py-4">
                <p className="text-[11px] uppercase tracking-[0.24em] text-white/40">{L('mostActive')}</p>
                <p className="mt-3 truncate text-lg font-semibold text-white">
                  {typeof mostActiveContact === 'string' ? mostActiveContact : getContactName(mostActiveContact)}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-3 xl:justify-end">
              {/* Language toggle */}
              <button
                type="button"
                onClick={toggleLocale}
                className="brand-inset rounded-2xl px-4 py-3 text-sm font-medium transition hover:border-[#00a884]/60 hover:text-[#00a884]"
                title={locale === 'en' ? 'Cambiar a Espanol' : 'Switch to English'}
              >
                {locale === 'en' ? 'ES' : 'EN'}
              </button>
              <Link
                to="/"
                className="brand-inset rounded-2xl px-4 py-3 text-sm font-medium transition hover:border-[#00a884]/60 hover:text-[#00a884]"
              >
                {L('home')}
              </Link>
              <button
                onClick={signOut}
                className="rounded-2xl bg-[#00a884] px-4 py-3 text-sm font-semibold text-[#07141a] transition hover:brightness-110"
              >
                {L('signOut')}
              </button>
            </div>
          </div>
        </header>

        {error ? (
          <div className="rounded-[28px] border border-red-400/20 bg-red-500/10 p-4 text-red-200 backdrop-blur-xl">
            {error}
          </div>
        ) : null}

        <div className="grid flex-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)_320px]">
          <aside
            className={`brand-panel flex h-[calc(100vh-200px)] flex-col overflow-hidden rounded-[32px] transition duration-300 ${
              isMobileConversationOpen ? 'hidden xl:flex' : 'flex'
            }`}
          >
            <div className="border-b border-white/8 px-5 pb-4 pt-5">
              <p className="brand-kicker text-[10px] text-white/40">{L('liveInbox')}</p>
              <h2 className="mt-2 text-2xl font-semibold text-white">{L('contactsTitle')}</h2>
              <p className="mt-2 text-sm text-white/55">{L('observeInteractions')}</p>
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={L('searchContacts')}
                className="brand-inset mt-4 w-full rounded-2xl px-4 py-3 text-sm text-white placeholder-white/28 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
              />
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-3">
              {filteredConversations.length === 0 ? (
                <div className="brand-inset mx-2 rounded-[24px] border-dashed px-4 py-8 text-center text-sm text-white/58">
                  {L('noConversationsFound')}
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
                  <p className="text-[11px] uppercase tracking-[0.24em] text-white/40">{L('invites')}</p>
                  <p className="mt-2 text-lg font-semibold text-white">{L('inviteManagement')}</p>
                </div>
                <span className="text-sm text-white/54">{invitePanelOpen ? L('hide') : L('show')}</span>
              </button>

              {invitePanelOpen ? (
                <div className="brand-inset mt-3 rounded-[24px] p-4">
                  <div className="flex gap-3">
                    <input
                      type="text"
                      value={label}
                      onChange={(event) => setLabel(event.target.value)}
                      placeholder={L('optionalInviteLabel')}
                      className="brand-inset min-w-0 flex-1 rounded-2xl px-4 py-3 text-sm text-white placeholder-white/28 outline-none focus:border-[#00a884] focus:ring-2 focus:ring-[#00a884]/20"
                    />
                    <button
                      type="button"
                      onClick={handleGenerate}
                      disabled={inviteBusy}
                      className="rounded-2xl bg-[#00a884] px-4 py-3 text-sm font-semibold text-[#07141a] transition hover:brightness-110 disabled:opacity-60"
                    >
                      {inviteBusy ? L('generating') : L('generate')}
                    </button>
                  </div>
                  <div className="mt-4 max-h-52 space-y-2 overflow-y-auto">
                    {links.length === 0 ? (
                      <div className="rounded-[20px] border border-white/6 bg-black/14 px-3 py-4 text-sm text-white/56">
                        {L('noInviteLinksYet')}
                      </div>
                    ) : null}
                    {links.map((link) => (
                      <div key={link.id} className="rounded-[20px] border border-white/6 bg-black/14 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white">{link.label || L('untitledInvite')}</p>
                            <p className="mt-1 text-xs text-white/46">{link.use_count} {L('uses')}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleToggle(link.id, link.active)}
                            className={`rounded-full px-3 py-1 text-xs font-medium ${
                              link.active ? 'bg-[#00a884]/18 text-[#7be3ce]' : 'bg-white/8 text-white/60'
                            }`}
                          >
                            {link.active ? L('active') : L('inactive')}
                          </button>
                        </div>
                        <div className="mt-3 flex gap-2">
                          <button
                            type="button"
                            onClick={() => copyLink(link.token, link.id)}
                            className="rounded-xl border border-white/10 px-3 py-2 text-xs text-white/78 transition hover:border-[#00a884]/55 hover:text-[#00a884]"
                          >
                            {copiedId === link.id ? L('copied') : L('copyLink')}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(link.id)}
                            className="rounded-xl border border-red-400/20 px-3 py-2 text-xs text-red-300/70 transition hover:border-red-400/50 hover:text-red-300"
                          >
                            {L('delete')}
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
            className={`brand-panel h-[calc(100vh-200px)] overflow-hidden rounded-[32px] ${
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
                      <p className="text-xs uppercase tracking-[0.24em] text-white/38">{L('observerMode')}</p>
                      <p className="mt-2 text-sm text-white/58">{L('avatarHandlesReplies')}</p>
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
                      {L('noMessagesYet')}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {selectedMessages.map((message, idx) => {
                        const isContact = message.sender === 'contact'
                        const isFirst = idx === 0 || selectedMessages[idx - 1].sender !== message.sender
                        return (
                          <div key={message.id} className={`flex ${isContact ? 'justify-start' : 'justify-end'} ${isFirst ? '' : '-mt-1.5'}`}>
                            <div
                              className={`group relative max-w-[85%] rounded-[22px] border px-4 py-3 transition-all duration-200 hover:scale-[1.01] ${
                                isContact
                                  ? 'rounded-tl-md border-white/[0.07] bg-[linear-gradient(135deg,rgba(22,34,51,0.92),rgba(15,25,40,0.96))] shadow-[0_8px_32px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.04)]'
                                  : 'rounded-tr-md border-[#00a884]/15 bg-[linear-gradient(135deg,rgba(0,168,132,0.18),rgba(0,140,110,0.22))] shadow-[0_8px_32px_rgba(0,168,132,0.12),inset_0_1px_0_rgba(0,168,132,0.15)]'
                              }`}
                            >
                              {/* Subtle glow for avatar messages */}
                              {!isContact && (
                                <div className="pointer-events-none absolute -inset-[1px] rounded-[22px] bg-[radial-gradient(ellipse_at_top_right,rgba(0,168,132,0.08),transparent_60%)]" />
                              )}
                              <div className="relative">
                                <div className="mb-1.5 flex items-center gap-2">
                                  <span className={`flex h-[18px] items-center rounded-full px-2 text-[9px] font-bold uppercase tracking-[0.15em] ${
                                    isContact
                                      ? 'bg-white/[0.06] text-white/50'
                                      : 'bg-[#00a884]/15 text-[#00a884]/80'
                                  }`}>
                                    {isContact ? L('contact') : L('avatar')}
                                  </span>
                                  {message.type !== 'text' && (
                                    <span className={`flex h-[18px] items-center rounded-full px-2 text-[9px] uppercase tracking-wider ${
                                      isContact ? 'bg-white/[0.04] text-white/35' : 'bg-[#00a884]/8 text-[#00a884]/50'
                                    }`}>
                                      {message.type === 'voice' ? '\u{1F3A4}' : message.type === 'image' ? '\u{1F4F7}' : '\u{1F3AC}'} {message.type}
                                    </span>
                                  )}
                                </div>
                                {message.media_url && message.type === 'image' ? (
                                  <img src={message.media_url} alt="Shared media" className="mt-1.5 max-h-80 rounded-[16px] object-cover shadow-[0_4px_20px_rgba(0,0,0,0.3)]" />
                                ) : null}
                                {message.media_url && message.type === 'video' ? (
                                  <video src={message.media_url} controls playsInline className="mt-1.5 max-h-96 rounded-[16px] shadow-[0_4px_20px_rgba(0,0,0,0.3)]" />
                                ) : null}
                                {message.media_url && message.type === 'voice' ? (
                                  <div className="mt-1.5 overflow-hidden rounded-[14px] bg-black/20 p-1">
                                    <audio src={message.media_url} controls className="w-full min-w-[220px]" />
                                  </div>
                                ) : null}
                                <p className={`whitespace-pre-wrap text-[13.5px] leading-[1.65] text-white/90 ${message.media_url ? 'mt-2.5' : ''}`}>
                                  {formatMessagePreview(message.content, message.type)}
                                </p>
                                {message.duration_sec != null && message.duration_sec > 0 && (
                                  <span className="mt-1 inline-block text-[10px] text-white/30">
                                    {Math.floor(message.duration_sec / 60)}:{String(message.duration_sec % 60).padStart(2, '0')}
                                  </span>
                                )}
                                <div className="mt-2 flex items-center justify-end gap-2 text-[10px] text-white/30">
                                  <span>{formatMessageTime(message.created_at)}</span>
                                </div>
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
                  <h2 className="mt-6 text-3xl font-semibold text-white">{L('selectConversation')}</h2>
                  <p className="mt-3 text-sm leading-7 text-white/58">
                    {L('selectConversationDesc')}
                  </p>
                </div>
              </div>
            )}
          </section>

          <aside className="brand-panel flex h-[calc(100vh-200px)] flex-col overflow-hidden rounded-[32px]">
            <div className="border-b border-white/8 px-5 pb-4 pt-5">
              <p className="brand-kicker text-[10px] text-white/40">{L('insights')}</p>
              <h2 className="mt-2 text-2xl font-semibold text-white">{L('conversationIntelligence')}</h2>
              <p className="mt-2 text-sm text-white/55">{L('operationalVisibility')}</p>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-4">
              {selectedConversation ? (
                <div className="space-y-3">
                  {/* Key Metrics Grid */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="brand-inset rounded-[20px] p-3.5">
                      <p className="text-[10px] uppercase tracking-[0.2em] text-white/35">{L('totalMessages')}</p>
                      <p className="mt-1.5 text-2xl font-bold text-white">{selectedInsights.total}</p>
                      <p className="mt-0.5 text-[11px] text-white/45">{selectedInsights.contactMessages} {L('inbound')} · {selectedInsights.avatarMessages} {L('outbound')}</p>
                    </div>
                    <div className="brand-inset rounded-[20px] p-3.5">
                      <p className="text-[10px] uppercase tracking-[0.2em] text-white/35">{L('responseTime')}</p>
                      <p className="mt-1.5 text-2xl font-bold text-[#00a884]">{selectedInsights.avgResponseLabel}</p>
                      <p className="mt-0.5 text-[11px] text-white/45">{L('avgResponse')}</p>
                    </div>
                    <div className="brand-inset rounded-[20px] p-3.5">
                      <p className="text-[10px] uppercase tracking-[0.2em] text-white/35">{L('engagement')}</p>
                      <p className="mt-1.5 text-2xl font-bold text-white">{selectedInsights.engagementPct}%</p>
                      <p className="mt-0.5 text-[11px] text-white/45">{L('contactInitiated')}</p>
                    </div>
                    <div className="brand-inset rounded-[20px] p-3.5">
                      <p className="text-[10px] uppercase tracking-[0.2em] text-white/35">{L('duration')}</p>
                      <p className="mt-1.5 text-2xl font-bold text-white">{selectedInsights.durationLabel}</p>
                      <p className="mt-0.5 text-[11px] text-white/45">{L('peakAt')} {selectedInsights.peakTime}</p>
                    </div>
                  </div>

                  {/* Media Mix */}
                  <div className="brand-inset rounded-[20px] p-4">
                    <p className="text-[10px] uppercase tracking-[0.2em] text-white/35">{L('mediaMix')}</p>
                    <div className="mt-3 space-y-2">
                      {selectedInsights.mediaBreakdown.map((bar) => (
                        <div key={bar.label} className="flex items-center gap-2.5">
                          <span className="w-12 text-right text-[11px] text-white/55">{bar.label}</span>
                          <div className="flex-1">
                            <div
                              className="h-[18px] rounded-full"
                              style={{
                                width: `${Math.max(8, (bar.count / selectedInsights.maxMedia) * 100)}%`,
                                backgroundColor: bar.color,
                                opacity: 0.7,
                              }}
                            />
                          </div>
                          <span className="w-6 text-right text-xs font-semibold text-white">{bar.count}</span>
                        </div>
                      ))}
                    </div>
                    {selectedInsights.voiceMinutes > 0 && (
                      <p className="mt-2.5 text-[11px] text-white/45">{selectedInsights.voiceMinutes} min {L('voiceAudio')}</p>
                    )}
                  </div>

                  {/* Behavioral Signals */}
                  <div className="brand-inset rounded-[20px] p-4">
                    <p className="text-[10px] uppercase tracking-[0.2em] text-white/35">{L('behavioralSignals')}</p>
                    <div className="mt-3 space-y-2">
                      {selectedInsights.signals.map((signal) => (
                        <div key={signal.label} className="flex items-start gap-2.5 rounded-[14px] border border-white/5 bg-white/[0.03] px-3 py-2.5">
                          <span
                            className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                            style={{ backgroundColor: `${signal.color}20`, color: signal.color }}
                          >{signal.icon}</span>
                          <div className="min-w-0">
                            <p className="text-[12px] font-semibold" style={{ color: signal.color }}>{signal.label}</p>
                            <p className="mt-0.5 text-[11px] leading-4 text-white/50">{signal.desc}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Strengths & Weaknesses */}
                  {(selectedInsights.strengths.length > 0 || selectedInsights.weaknesses.length > 0) && (
                    <div className="brand-inset rounded-[20px] p-4">
                      <p className="text-[10px] uppercase tracking-[0.2em] text-white/35">{L('assessment')}</p>
                      <div className="mt-3 space-y-2">
                        {selectedInsights.strengths.map((s) => (
                          <div key={s.label} className="flex items-start gap-2.5">
                            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#00a884]/15 text-[10px] text-[#00a884]">{'\u2713'}</span>
                            <div>
                              <p className="text-[12px] font-medium text-[#00a884]">{s.label}</p>
                              <p className="text-[11px] leading-4 text-white/45">{s.detail}</p>
                            </div>
                          </div>
                        ))}
                        {selectedInsights.weaknesses.map((w) => (
                          <div key={w.label} className="flex items-start gap-2.5">
                            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-400/15 text-[10px] text-amber-400">{'\u26A0'}</span>
                            <div>
                              <p className="text-[12px] font-medium text-amber-400">{w.label}</p>
                              <p className="text-[11px] leading-4 text-white/45">{w.detail}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Recommendations */}
                  <div className="brand-inset rounded-[20px] p-4">
                    <p className="text-[10px] uppercase tracking-[0.2em] text-white/35">{L('recommendations')}</p>
                    <div className="mt-3 space-y-2">
                      {selectedInsights.recommendations.map((rec) => (
                        <div key={rec.text} className="flex items-start gap-2.5">
                          <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${
                            rec.priority === 'high' ? 'bg-red-400' : rec.priority === 'medium' ? 'bg-amber-400' : 'bg-[#00a884]'
                          }`} />
                          <p className="text-[12px] leading-5 text-white/65">{rec.text}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Contact Profile */}
                  <div className="brand-inset rounded-[20px] p-4">
                    <p className="text-[10px] uppercase tracking-[0.2em] text-white/35">{L('contactProfile')}</p>
                    <div className="mt-3 space-y-2.5 text-[12px] text-white/60">
                      <div className="flex items-center justify-between">
                        <span>{L('languageDetected')}</span>
                        <span className="font-medium text-white/80">{selectedInsights.language}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>{L('avgMessageLength')}</span>
                        <span className="font-medium text-white/80">{selectedInsights.avgMsgLen} {L('chars')}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>{L('peakActivity')}</span>
                        <span className="font-medium text-white/80">{selectedInsights.peakTime}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-center text-sm text-white/56">
                  {L('selectConversationForInsights')}
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
