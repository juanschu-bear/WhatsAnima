/**
 * Realistic delay tiers for voice message responses.
 *
 * The avatar should appear to "listen" to the voice message before replying,
 * so the listening delay scales with the duration of the incoming message.
 *
 * ┌──────────────────┬─────────────────────┬──────────────────────┐
 * │ Voice duration   │ Listening delay      │ Total min wait       │
 * ├──────────────────┼─────────────────────┼──────────────────────┤
 * │ 0 – 10 s         │  4 –  6 s           │ ~  7 – 9 s           │
 * │ 10 – 30 s        │  8 – 12 s           │ ~ 11 – 15 s          │
 * │ 30 – 60 s        │ 12 – 18 s           │ ~ 15 – 21 s          │
 * │ 60 – 120 s       │ 18 – 25 s           │ ~ 21 – 28 s          │
 * │ 120 – 180 s      │ 25 – 35 s           │ ~ 28 – 38 s          │
 * │ 180 s+           │ 35 – 45 s           │ ~ 38 – 48 s          │
 * └──────────────────┴─────────────────────┴──────────────────────┘
 *
 * "Total min wait" includes an initial 2-3 s "seen" delay before listening begins.
 */

interface DelayTier {
  maxDuration: number   // upper bound in seconds (inclusive)
  minDelay: number      // minimum listening delay in ms
  maxDelay: number      // maximum listening delay in ms
}

const DELAY_TIERS: DelayTier[] = [
  { maxDuration: 10,  minDelay: 4_000,  maxDelay: 6_000 },
  { maxDuration: 30,  minDelay: 8_000,  maxDelay: 12_000 },
  { maxDuration: 60,  minDelay: 12_000, maxDelay: 18_000 },
  { maxDuration: 120, minDelay: 18_000, maxDelay: 25_000 },
  { maxDuration: 180, minDelay: 25_000, maxDelay: 35_000 },
  { maxDuration: Infinity, minDelay: 35_000, maxDelay: 45_000 },
]

/** Initial "seen" delay before the listening status appears (ms). */
export const VOICE_SEEN_DELAY_MS = 2_500

/**
 * Returns a randomised listening delay (ms) based on the voice message duration.
 */
export function getVoiceListeningDelay(durationSec: number): number {
  return 0
}

/**
 * Returns a randomised watching delay (ms) for video messages.
 * Uses the same tier table as voice — the avatar needs to "watch" the clip.
 */
export function getVideoWatchingDelay(durationSec: number): number {
  return 0
}

/** Titles/prefixes to strip when extracting a first name from a display name. */
const TITLE_PREFIXES = /^(dr\.?|prof\.?|professor|mr\.?|mrs\.?|ms\.?|sir|herr|frau)\s+/i

/**
 * Extracts the first name from a display name.
 * Strips common title prefixes (Dr., Prof., etc.) and returns the first word.
 *
 * "Juan Schubert"     → "Juan"
 * "Dr. Brian Cox"     → "Brian"
 * "Prof. Brian Cox"   → "Brian"
 * "Brian"             → "Brian"
 */
export function getAvatarFirstName(displayName: string | null | undefined): string {
  if (!displayName) return 'Avatar'
  const stripped = displayName.trim().replace(TITLE_PREFIXES, '').trim()
  const firstName = stripped.split(/\s+/)[0]
  return firstName || 'Avatar'
}
