export type ChecklistInvitation = {
  status: 'pending' | 'accepted' | 'expired' | 'revoked'
  expires_at: string
  allowed_avatars: string[]
}

export function isInvitationAcceptable(invitation: ChecklistInvitation, now = Date.now()) {
  if (invitation.status !== 'pending') return false
  if (!Array.isArray(invitation.allowed_avatars) || invitation.allowed_avatars.length === 0) return false
  const expiry = new Date(invitation.expires_at).getTime()
  return Number.isFinite(expiry) && expiry > now
}

export function resolveVisibleAvatars(
  allAvatars: string[],
  allowedAvatars: string[],
  isOwner: boolean,
) {
  if (isOwner) return [...allAvatars]
  const allowed = new Set(allowedAvatars.map((item) => item.trim()).filter(Boolean))
  return allAvatars.filter((avatar) => allowed.has(avatar))
}

export function buildOnboardingCallPayload(input: {
  conversationId: string
  avatarName: string
  userId: string
  language: string
}) {
  return {
    conversationId: input.conversationId,
    triggerText: 'onboarding_first_call',
    callerDisplayName: input.avatarName,
    userId: input.userId,
    language: input.language || 'en',
  }
}

export function shouldUseOnboardingPrompt(input: {
  triggerText: string
  onboardingCompleted: boolean
  hasPriorTranscript: boolean
}) {
  if (input.onboardingCompleted) return false
  if (input.triggerText.trim() === 'onboarding_first_call') return true
  return !input.hasPriorTranscript
}

export function canAccessConversation(input: {
  isOwner: boolean
  currentUserId: string
  conversationUserId: string
}) {
  if (input.isOwner) return true
  return input.currentUserId === input.conversationUserId
}

export function isResetRedirectToDedicatedPage(redirectTo: string) {
  return redirectTo.includes('/auth/reset-password')
}
