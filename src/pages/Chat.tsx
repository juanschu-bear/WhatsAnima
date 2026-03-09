import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { getConversation, listMessages, sendMessage } from '../lib/api'

interface Message {
  id: string
  sender: 'contact' | 'avatar'
  type: 'text' | 'voice'
  content: string
  media_url: string | null
  duration_sec: number | null
  created_at: string
}

interface ConversationData {
  id: string
  owner_id: string
  wa_owners: {
    display_name: string
    avatar_url: string | null
    voice_id: string | null
    tavus_replica_id: string | null
  }
  wa_contacts: { display_name: string }
}

export default function Chat() {
  const { conversationId } = useParams<{ conversationId: string }>()
  const [conversation, setConversation] = useState<ConversationData | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [recording, setRecording] = useState(false)
  const [avatarTyping, setAvatarTyping] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  useEffect(() => {
    if (!conversationId) return
    Promise.all([getConversation(conversationId), listMessages(conversationId)])
      .then(([conv, msgs]) => {
        setConversation(conv as ConversationData)
        setMessages(msgs as Message[])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [conversationId])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, avatarTyping])

  async function getAvatarReply(
    userMessage: string,
    voiceId: string | null | undefined
  ): Promise<{ content: string; mediaUrl: string | null }> {
    if (!voiceId) {
      return {
        content: 'Voice service is not configured for this owner.',
        mediaUrl: null,
      }
    }

    try {
      const replyText = `You said: "${userMessage}". Thank you for your message! I'm here to chat with you.`
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: replyText,
          voiceId,
        }),
      })

      if (!response.ok) {
        return {
          content: 'Sorry, I could not generate a voice response right now.',
          mediaUrl: null,
        }
      }

      const audioBlob = await response.blob()
      const audioUrl = URL.createObjectURL(audioBlob)
      const audio = new Audio(audioUrl)
      await audio.play().catch(() => {})

      return {
        content: replyText,
        mediaUrl: audioUrl,
      }
    } catch {
      return {
        content: 'Sorry, something went wrong generating my response.',
        mediaUrl: null,
      }
    }
  }

  async function handleSendText() {
    if (!text.trim() || !conversationId || sending) return
    const content = text.trim()
    setText('')
    setSending(true)

    try {
      const msg = await sendMessage(conversationId, 'contact', 'text', content)
      setMessages((prev) => [...prev, msg as Message])

      setAvatarTyping(true)
      const ownerVoiceId = conversation?.wa_owners.voice_id
      const replyPayload = await getAvatarReply(content, ownerVoiceId)
      const reply = await sendMessage(
        conversationId,
        'avatar',
        'voice',
        replyPayload.content,
        replyPayload.mediaUrl ?? undefined
      )
      setMessages((prev) => [...prev, reply as Message])
    } finally {
      setAvatarTyping(false)
      setSending(false)
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream)
      mediaRecorderRef.current = mediaRecorder
      chunksRef.current = []

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        if (!conversationId) return

        setSending(true)
        try {
          const msg = await sendMessage(
            conversationId,
            'contact',
            'voice',
            'Voice note',
            undefined,
            Math.round(blob.size / 1000)
          )
          setMessages((prev) => [...prev, msg as Message])

          setAvatarTyping(true)
          const ownerVoiceId = conversation?.wa_owners.voice_id
          const replyPayload = await getAvatarReply('a voice message', ownerVoiceId)
          const reply = await sendMessage(
            conversationId,
            'avatar',
            'voice',
            replyPayload.content,
            replyPayload.mediaUrl ?? undefined
          )
          setMessages((prev) => [...prev, reply as Message])
        } finally {
          setAvatarTyping(false)
          setSending(false)
        }
      }

      mediaRecorder.start()
      setRecording(true)
    } catch {
      // Microphone permission denied
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop()
    setRecording(false)
  }

  function formatTime(dateStr: string) {
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-[#0b141a]">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-emerald-500 border-t-transparent" />
      </div>
    )
  }

  if (!conversation) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center bg-[#0b141a] px-4 text-center">
        <p className="text-lg text-white/60">Conversation not found.</p>
      </div>
    )
  }

  const owner = conversation.wa_owners

  return (
    <div className="flex h-dvh flex-col bg-[#0b141a]">
      {/* Header */}
      <header className="flex items-center gap-3 bg-[#1f2c34] px-4 py-3 shadow-lg">
        {owner.avatar_url ? (
          <img
            src={owner.avatar_url}
            alt={owner.display_name}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-700 text-sm font-bold text-white">
            {owner.display_name.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-white">{owner.display_name}</h1>
          <p className="text-xs text-emerald-400">
            {avatarTyping ? 'typing...' : 'online'}
          </p>
        </div>
      </header>

      {/* Messages */}
      <main
        className="flex-1 overflow-y-auto px-3 py-4"
        style={{
          backgroundImage:
            'url("data:image/svg+xml,%3Csvg width=\'60\' height=\'60\' viewBox=\'0 0 60 60\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cg fill=\'none\' fill-rule=\'evenodd\'%3E%3Cg fill=\'%23ffffff\' fill-opacity=\'0.02\'%3E%3Cpath d=\'M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z\'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")',
        }}
      >
        <div className="mx-auto flex max-w-2xl flex-col gap-1">
          {messages.map((msg) => {
            const isContact = msg.sender === 'contact'
            return (
              <div
                key={msg.id}
                className={`flex ${isContact ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`relative max-w-[80%] rounded-lg px-3 py-2 text-sm shadow ${
                    isContact
                      ? 'rounded-tr-none bg-[#005c4b] text-white'
                      : 'rounded-tl-none bg-[#1f2c34] text-white'
                  }`}
                >
                  {msg.type === 'voice' && (
                    <span className="mr-1 inline-block text-emerald-300">
                      <svg className="inline h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1 1.93c-3.94-.49-7-3.85-7-7.93h2c0 3.31 2.69 6 6 6s6-2.69 6-6h2c0 4.08-3.06 7.44-7 7.93V19h4v2H8v-2h4v-3.07z" />
                      </svg>
                    </span>
                  )}
                  <span>{msg.content}</span>
                  <span className="ml-2 inline-block text-[10px] leading-none text-white/40">
                    {formatTime(msg.created_at)}
                  </span>
                </div>
              </div>
            )
          })}

          {avatarTyping && (
            <div className="flex justify-start">
              <div className="rounded-lg rounded-tl-none bg-[#1f2c34] px-4 py-3 shadow">
                <div className="flex gap-1">
                  <span className="h-2 w-2 animate-bounce rounded-full bg-white/40" style={{ animationDelay: '0ms' }} />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-white/40" style={{ animationDelay: '150ms' }} />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-white/40" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </main>

      {/* Input */}
      <footer className="bg-[#1f2c34] px-3 py-2">
        <div className="mx-auto flex max-w-2xl items-end gap-2">
          {/* Voice note button */}
          <button
            onClick={recording ? stopRecording : startRecording}
            disabled={sending && !recording}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition ${
              recording
                ? 'animate-pulse bg-red-500 text-white'
                : 'bg-emerald-600 text-white hover:bg-emerald-700'
            } disabled:opacity-40`}
            title={recording ? 'Stop recording' : 'Record voice note'}
          >
            {recording ? (
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            ) : (
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1 1.93c-3.94-.49-7-3.85-7-7.93h2c0 3.31 2.69 6 6 6s6-2.69 6-6h2c0 4.08-3.06 7.44-7 7.93V19h4v2H8v-2h4v-3.07z" />
              </svg>
            )}
          </button>

          {/* Text input */}
          <div className="min-w-0 flex-1">
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSendText()
                }
              }}
              placeholder="Type a message"
              disabled={sending || recording}
              className="w-full rounded-full bg-[#2a3942] px-4 py-2.5 text-sm text-white placeholder-white/30 outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-40"
            />
          </div>

          {/* Send button */}
          <button
            onClick={handleSendText}
            disabled={!text.trim() || sending || recording}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white transition hover:bg-emerald-700 disabled:opacity-40"
            title="Send message"
          >
            <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
      </footer>
    </div>
  )
}
