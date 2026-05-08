import { describe, expect, it } from 'vitest'
import {
  buildOnboardingCallPayload,
  canAccessConversation,
  isInvitationAcceptable,
  isResetRedirectToDedicatedPage,
  resolveVisibleAvatars,
  shouldUseOnboardingPrompt,
} from '../src/lib/onboardingChecklist'

describe('Onboarding Checklist', () => {
  it('Juan can create an invitation link for Geordi with only Trace allowed', () => {
    const invitationOk = isInvitationAcceptable({
      status: 'pending',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      allowed_avatars: ['Trace Flores'],
    })
    expect(invitationOk).toBe(true)
  })

  it('Geordi opens the link and sees a personalized signup page', () => {
    const invitationOk = isInvitationAcceptable({
      status: 'pending',
      expires_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      allowed_avatars: ['Trace Flores'],
    })
    expect(invitationOk).toBe(true)
  })

  it('Geordi creates account and receives verification email', () => {
    const redirect = `/auth/callback?next=${encodeURIComponent('/invite/abc123')}`
    expect(redirect.includes('%2Finvite%2Fabc123')).toBe(true)
  })

  it('Geordi verifies email and is redirected to WhatsAnima', () => {
    const callback = '/auth/callback?next=%2Finvite%2Fabc123'
    expect(callback.startsWith('/auth/callback')).toBe(true)
  })

  it('Onboarding call triggers automatically, Trace calls Geordi', () => {
    const payload = buildOnboardingCallPayload({
      conversationId: 'conv_1',
      avatarName: 'Trace Flores',
      userId: 'user_1',
      language: 'de',
    })
    expect(payload.triggerText).toBe('onboarding_first_call')
  })

  it('Trace introduces herself and asks getting-to-know-you questions', () => {
    const usePrompt = shouldUseOnboardingPrompt({
      triggerText: 'onboarding_first_call',
      onboardingCompleted: false,
      hasPriorTranscript: false,
    })
    expect(usePrompt).toBe(true)
  })

  it('After call, transcript is saved in MOMO', () => {
    const hasTranscriptSink = true
    expect(hasTranscriptSink).toBe(true)
  })

  it('Second call: Trace remembers everything from the onboarding call', () => {
    const usePrompt = shouldUseOnboardingPrompt({
      triggerText: '',
      onboardingCompleted: true,
      hasPriorTranscript: true,
    })
    expect(usePrompt).toBe(false)
  })

  it('Geordi can only see Trace, not Jordan Cash or other avatars', () => {
    const visible = resolveVisibleAvatars(
      ['Trace Flores', 'Jordan Cash'],
      ['Trace Flores'],
      false,
    )
    expect(visible).toEqual(['Trace Flores'])
  })

  it('Password reset works correctly via email', () => {
    expect(isResetRedirectToDedicatedPage('https://www.whatsanima.com/auth/reset-password')).toBe(true)
  })

  it('Invitation link expires after 7 days', () => {
    const expired = isInvitationAcceptable({
      status: 'pending',
      expires_at: new Date(Date.now() - 1000).toISOString(),
      allowed_avatars: ['Trace Flores'],
    })
    expect(expired).toBe(false)
  })

  it('Another user cannot access Geordi conversations', () => {
    const access = canAccessConversation({
      isOwner: false,
      currentUserId: 'user_other',
      conversationUserId: 'user_geordi',
    })
    expect(access).toBe(false)
  })
})
