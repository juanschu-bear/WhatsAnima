import { describe, expect, it } from 'vitest'
import { extractTemporalFacts } from '../api/_lib/temporalMemory'

describe('temporal memory extraction', () => {
  it('extracts future event for next weekday reminder', () => {
    const items = extractTemporalFacts({
      text: 'Erinner mich nächsten Donnerstag um 20 Uhr',
      timezone: 'Europe/Berlin',
      lang: 'de',
    })
    expect(items.length).toBeGreaterThan(0)
    expect(items[0].category).toBe('future_event')
    expect(items[0].refers_to).toBeTruthy()
  })

  it('extracts conversational plan for tomorrow evening', () => {
    const items = extractTemporalFacts({
      text: 'Lass uns morgen Abend weiterreden',
      timezone: 'Europe/Berlin',
      lang: 'de',
    })
    expect(items.length).toBeGreaterThan(0)
    expect(['conversational_plan', 'future_event']).toContain(items[0].category)
  })

  it('extracts relative plan horizon', () => {
    const items = extractTemporalFacts({
      text: 'I want to sell the practice in 12 to 18 months',
      timezone: 'Europe/Berlin',
      lang: 'en',
    })
    expect(items.length).toBeGreaterThan(0)
    expect(items[0].category).toBe('relative_plan')
  })
})

