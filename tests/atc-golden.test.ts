import { describe, expect, it } from 'vitest'
import { parseOutboundCallIntent } from '../src/lib/callIntent'
import { extractTemporalFacts } from '../api/_lib/temporalMemory'
import { normalizeCallSummaryText } from '../api/_lib/callSummary'

describe('ATC golden expressions DE/EN/ES', () => {
  it('does not trigger outbound on call noun context', () => {
    expect(parseOutboundCallIntent('Weißt du worüber wir im letzten Call gesprochen haben?')).toBeNull()
    expect(parseOutboundCallIntent('Do you remember what we discussed in the last call?')).toBeNull()
    expect(parseOutboundCallIntent('Sabes de qué hablamos en la última llamada?')).toBeNull()
  })

  it('triggers outbound on explicit call request DE/EN/ES', () => {
    expect(parseOutboundCallIntent('Ruf mich an')?.delayMinutes).toBe(0)
    expect(parseOutboundCallIntent('Call me now')?.delayMinutes).toBe(0)
    expect(parseOutboundCallIntent('Llámame ahora')?.delayMinutes).toBe(0)
  })

  it('parses delayed call request DE/EN/ES', () => {
    expect(parseOutboundCallIntent('Ruf mich in 10 Minuten an')?.delayMinutes).toBe(10)
    expect(parseOutboundCallIntent('Call me in 15 minutes')?.delayMinutes).toBe(15)
    expect(parseOutboundCallIntent('Llámame en 20 minutos')?.delayMinutes).toBe(20)
  })

  it('extracts temporal categories from multilingual inputs', () => {
    expect(extractTemporalFacts({ text: 'I have a meeting at 3 PM tomorrow', timezone: 'Europe/Berlin', lang: 'en' })[0]?.category).toBe('future_event')
    expect(extractTemporalFacts({ text: 'Ich muss das bis Freitag abgeben', timezone: 'Europe/Berlin', lang: 'de' })[0]?.category).toBe('deadline')
    expect(extractTemporalFacts({ text: 'Trabajo cada lunes', timezone: 'Europe/Berlin', lang: 'es' })[0]?.category).toBe('recurring')
  })

  it('normalizes JSON and raw call summaries', () => {
    const jsonSummary = normalizeCallSummaryText(JSON.stringify({ summary_text: 'We aligned on tax strategy.' }))
    const rawSummary = normalizeCallSummaryText('Simple raw summary')
    expect(jsonSummary).toBe('We aligned on tax strategy.')
    expect(rawSummary).toBe('Simple raw summary')
  })
})

