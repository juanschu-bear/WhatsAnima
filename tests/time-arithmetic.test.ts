import { describe, expect, it } from 'vitest'
import { buildDirectTimeReply } from '../api/chat'

describe('time arithmetic direct replies', () => {
  it('handles forward arithmetic', () => {
    const out = buildDirectTimeReply('Wie spät ist es in einer Stunde?', 'Europe/Berlin')
    expect(out.toLowerCase()).toContain('in einer stunde')
  })

  it('handles backwards arithmetic', () => {
    const out = buildDirectTimeReply('What time was it 30 minutes ago?', 'Europe/Berlin')
    expect(out.toLowerCase()).toContain('minutes ago')
  })

  it('handles city current time', () => {
    const out = buildDirectTimeReply('What time is it in Tokyo right now?', 'Europe/Berlin')
    expect(out.toLowerCase()).toContain('tokyo')
  })

  it('handles countdown', () => {
    const out = buildDirectTimeReply('How long until 5 PM?', 'Europe/Berlin')
    expect(out.toLowerCase()).toContain('left')
  })
})

