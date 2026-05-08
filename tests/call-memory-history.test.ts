import { describe, expect, it } from 'vitest'
import { mapHistoryRowsToChatHistory } from '../api/avatar-reply'

describe('call memory history mapping', () => {
  it('keeps call_summary entries as readable call memory context', () => {
    const rows = [
      { id: '1', sender: 'avatar', type: 'call_summary', content: '{"summary_text":"We discussed tax planning."}' },
      { id: '2', sender: 'contact', type: 'text', content: 'Do you remember the last call?' },
    ]
    const mapped = mapHistoryRowsToChatHistory(rows)
    expect(mapped.some((m) => m.content.includes('Call summary: We discussed tax planning.'))).toBe(true)
  })
})

