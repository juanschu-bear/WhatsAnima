import { describe, expect, it } from 'vitest'
import { syncChannelState } from '../api/_lib/channelConsistency'

function createSupabaseStub() {
  let row: any = null
  const api: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: row, error: null }),
        }),
      }),
      upsert: (patch: any) => ({
        select: () => ({
          single: async () => {
            row = { ...(row || {}), ...patch }
            return { data: row, error: null }
          },
        }),
      }),
    }),
  }
  return api
}

describe('channel consistency guard', () => {
  it('preserves canonical timezone/language across non-chat channels', async () => {
    const supabase = createSupabaseStub()
    await syncChannelState({
      supabase,
      conversationId: 'conv-1',
      channel: 'chat',
      timezone: 'Europe/Berlin',
      messageText: 'Hallo',
    })

    const next = await syncChannelState({
      supabase,
      conversationId: 'conv-1',
      channel: 'video',
      timezone: 'America/New_York',
      messageText: 'Hello',
    })

    expect(next.state?.timezone).toBe('Europe/Berlin')
    expect(next.state?.last_language).toBe('de')
  })
})

