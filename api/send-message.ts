import { createClient } from '@supabase/supabase-js'
import { syncChannelState } from './_lib/channelConsistency.js'
import { extractTemporalFacts, ingestTemporalMemories, upsertTemporalEvents } from './_lib/temporalMemory.js'

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY
  if (!url) return { client: null, missing: 'SUPABASE_URL' }
  if (!key) return { client: null, missing: 'SUPABASE_SERVICE_KEY' }
  return { client: createClient(url, key), missing: null }
}

export default async function handler(req: any, res: any) {
  if (!['POST', 'PATCH'].includes(req.method)) {
    res.setHeader('Allow', 'POST, PATCH')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { client: supabase, missing } = getSupabaseAdmin()
  if (!supabase) {
    return res.status(503).json({ error: `DB not configured – missing ${missing}` })
  }

  try {
    if (req.method === 'PATCH') {
      const { messageId, updates } = req.body ?? {}
      if (!messageId || !updates || typeof updates !== 'object') {
        return res.status(400).json({ error: 'messageId and updates are required' })
      }
      const { data, error } = await supabase
        .from('wa_messages')
        .update(updates)
        .eq('id', messageId)
        .select()
        .single()
      if (error) {
        console.error('[send-message] Update error:', error.message)
        return res.status(500).json({ error: error.message })
      }
      return res.status(200).json(data)
    }

    const {
      conversationId,
      sender,
      type,
      content,
      mediaUrl,
      durationSec,
      localId,
      transcriptInterim,
      transcriptFinal,
      transcriptStatus,
      audioStatus,
      audioRetryCount,
      audioLastError,
    } = req.body ?? {}

    if (!conversationId || !sender || !type) {
      return res.status(400).json({ error: 'conversationId, sender, and type are required' })
    }

    const { data, error } = await supabase
      .from('wa_messages')
      .insert({
        conversation_id: conversationId,
        sender,
        type,
        content: content ?? null,
        media_url: mediaUrl ?? null,
        duration_sec: durationSec ?? null,
        local_id: localId ?? null,
        transcript_interim: transcriptInterim ?? null,
        transcript_final: transcriptFinal ?? null,
        transcript_status: transcriptStatus ?? undefined,
        audio_status: audioStatus ?? undefined,
        audio_retry_count: audioRetryCount ?? undefined,
        audio_last_error: audioLastError ?? null,
      })
      .select()
      .single()

    if (error) {
      console.error('[send-message] Insert error:', error.message)
      return res.status(500).json({ error: error.message })
    }

    const { error: updateError } = await supabase
      .from('wa_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId)

    if (updateError) {
      console.error('[send-message] Conversation update error:', updateError.message)
    }

    await syncChannelState({
      supabase,
      conversationId: String(conversationId),
      channel: type === 'voice' ? 'voice' : type === 'video' ? 'video' : 'chat',
      timezone: String((req.body?.metadata?.timezone || req.body?.timezone || 'UTC')),
      messageText: sender === 'contact' ? String(content || '') : '',
    })

    if (sender === 'contact' && typeof content === 'string' && content.trim().length > 0) {
      const timezone = String((req.body?.metadata?.timezone || req.body?.timezone || 'UTC'))
      const { data: conv } = await supabase
        .from('wa_conversations')
        .select('owner_id, contact_id')
        .eq('id', conversationId)
        .maybeSingle()
      const ownerId = conv?.owner_id ? String(conv.owner_id) : null
      const contactId = conv?.contact_id ? String(conv.contact_id) : null
      let avatarName = 'Avatar'
      if (ownerId) {
        const { data: owner } = await supabase
          .from('wa_owners')
          .select('display_name')
          .eq('id', ownerId)
          .maybeSingle()
        if (owner?.display_name) avatarName = String(owner.display_name)
      }

      await ingestTemporalMemories({
        text: content,
        conversationId: String(conversationId),
        ownerId,
        avatarName,
        channel: type === 'voice' ? 'voice_message' : type === 'video' ? 'video_call' : 'chat',
        timezone,
      })

      const temporalItems = extractTemporalFacts({ text: content, timezone })
      if (contactId && temporalItems.length > 0) {
        await upsertTemporalEvents({
          supabase,
          userId: contactId,
          avatarName,
          temporalItems,
          preferredChannel: 'chat',
        })
      }
    }

    return res.status(200).json(data)
  } catch (err: any) {
    console.error('[send-message] Error:', err.message || err)
    return res.status(500).json({ error: err.message || 'Failed to send message' })
  }
}
