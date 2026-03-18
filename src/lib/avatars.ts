/**
 * Local avatar images mapped by owner display_name (lowercase).
 * Falls back to the default avatar (Juan Schubert) when no match is found.
 */

const DEFAULT_AVATAR = '/juan-schubert-192.jpg'

const AVATAR_MAP: Record<string, string> = {
  'juan schubert': '/juan-schubert-192.jpg',
  'brian cox': '/brian-cox-192.jpg',
  'prof. brian cox': '/brian-cox-192.jpg',
  'professor brian cox': '/brian-cox-192.jpg',
  'adri kastel': '/adri-kastel_192x192.jpg',
  'adri kastel growth expert': '/adri-kastel_192x192.jpg',
}

/** Resolve a local avatar URL for the given display name. Returns the default avatar if no specific match. */
export function resolveAvatarUrl(displayName: string | null | undefined): string {
  if (!displayName) return DEFAULT_AVATAR
  return AVATAR_MAP[displayName.toLowerCase()] ?? DEFAULT_AVATAR
}
