import { describe, expect, it } from 'vitest'
import { parseOutboundCallIntent } from '../src/lib/callIntent'

describe('call intent parser', () => {
  it('detects immediate outbound call intent for explicit request', () => {
    const intent = parseOutboundCallIntent('Ruf mich jetzt an')
    expect(intent).toBeTruthy()
    expect(intent?.delayMinutes).toBe(0)
  })

  it('detects delayed outbound call intent', () => {
    const intent = parseOutboundCallIntent('Ruf mich in 10 Minuten an')
    expect(intent).toBeTruthy()
    expect(intent?.delayMinutes).toBe(10)
  })

  it('does not misclassify call-memory questions as outbound trigger', () => {
    const intent = parseOutboundCallIntent('Weißt du, worüber wir im Call gesprochen haben?')
    expect(intent).toBeNull()
  })

  it('does not trigger on the exact regression sentence with "in dem Call"', () => {
    const text =
      'Okay nun hatten wir einen kurzen Call gehabt und ich moechte checken ob du noch weisst worueber wir eben gesprochen haben in dem Call'
    const intent = parseOutboundCallIntent(text)
    expect(intent).toBeNull()
  })

  it('does not trigger on the exact production sentence with punctuation/umlauts', () => {
    const text =
      'Okay, nun hatten wir einen kurzen Call gehabt und ich möchte checken, ob du noch weißt, worüber wir eben gesprochen haben in dem Call'
    const intent = parseOutboundCallIntent(text)
    expect(intent).toBeNull()
  })

  it('detects allowed direct forms only', () => {
    expect(parseOutboundCallIntent('kannst du mich anrufen')?.delayMinutes).toBe(0)
    expect(parseOutboundCallIntent('call me')?.delayMinutes).toBe(0)
    expect(parseOutboundCallIntent('llamame')?.delayMinutes).toBe(0)
    expect(parseOutboundCallIntent('ruf mich in 2 minuten an')?.delayMinutes).toBe(2)
  })
})
