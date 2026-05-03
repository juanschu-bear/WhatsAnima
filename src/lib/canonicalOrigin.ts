const CANONICAL_ORIGIN = 'https://www.whatsanima.com'
const CANONICAL_HOST = 'www.whatsanima.com'
const REDIRECT_HOSTS = new Set([
  'whatsanima.com',
  'whats-anima.vercel.app',
  'www.whats-anima.vercel.app',
])

export function getCanonicalOrigin() {
  return (import.meta.env.VITE_APP_URL as string | undefined)?.trim().replace(/\/+$/, '') || CANONICAL_ORIGIN
}

export function getCanonicalAppUrl(path = '/') {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${getCanonicalOrigin()}${normalizedPath}`
}

export function shouldForceCanonicalHost(locationLike: Pick<Location, 'hostname' | 'pathname' | 'search' | 'hash'>) {
  const hostname = String(locationLike.hostname || '').toLowerCase()
  return REDIRECT_HOSTS.has(hostname) && hostname !== CANONICAL_HOST
}

export function forceCanonicalHost() {
  if (typeof window === 'undefined') return false
  if (!shouldForceCanonicalHost(window.location)) return false
  const target = `${getCanonicalOrigin()}${window.location.pathname}${window.location.search}${window.location.hash}`
  window.location.replace(target)
  return true
}
