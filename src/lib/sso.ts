import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

type SsoPayload = {
  access_token: string
  refresh_token: string
  exp: number
}

function b64UrlEncode(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function b64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
  return atob(normalized + pad)
}

export function buildSsoLaunchUrl(baseUrl: string, session: Session | null): string {
  const target = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!target) return '#'
  if (!session?.access_token || !session?.refresh_token) return target
  const payload: SsoPayload = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    exp: Date.now() + 2 * 60 * 1000,
  }
  const token = b64UrlEncode(JSON.stringify(payload))
  // Include token in both query and hash to survive strict redirects/proxies.
  return `${target}/?sso=${encodeURIComponent(token)}#sso=${encodeURIComponent(token)}`
}

function extractSsoToken(): string | null {
  const hash = window.location.hash || ''
  const hashMatch = hash.match(/(?:^#|[?&])sso=([^&]+)/)
  if (hashMatch?.[1]) return hashMatch[1]
  const search = window.location.search || ''
  const queryMatch = search.match(/(?:^\?|&)sso=([^&]+)/)
  if (queryMatch?.[1]) return queryMatch[1]
  return null
}

export async function consumeSsoFromUrl(): Promise<void> {
  try {
    const token = extractSsoToken()
    if (!token) return
    const decoded = JSON.parse(b64UrlDecode(decodeURIComponent(token))) as SsoPayload
    if (!decoded?.access_token || !decoded?.refresh_token) return
    if (!decoded?.exp || Date.now() > decoded.exp) return
    await supabase.auth.setSession({
      access_token: decoded.access_token,
      refresh_token: decoded.refresh_token,
    })
  } catch (e) {
    console.warn('[sso] failed to consume handoff token', e)
  } finally {
    const url = new URL(window.location.href)
    const hadSsoInHash = url.hash.includes('sso=')
    const hadSsoInQuery = url.searchParams.has('sso')
    if (hadSsoInQuery) url.searchParams.delete('sso')
    if (hadSsoInHash) url.hash = ''
    if (hadSsoInHash || hadSsoInQuery) {
      history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`)
    }
  }
}
