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
  return `${target}/#sso=${encodeURIComponent(token)}`
}

export async function consumeSsoFromUrl(): Promise<void> {
  try {
    const hash = window.location.hash || ''
    const m = hash.match(/(?:^#|[?&])sso=([^&]+)/)
    if (!m?.[1]) return
    const decoded = JSON.parse(b64UrlDecode(decodeURIComponent(m[1]))) as SsoPayload
    if (!decoded?.access_token || !decoded?.refresh_token) return
    if (!decoded?.exp || Date.now() > decoded.exp) return
    await supabase.auth.setSession({
      access_token: decoded.access_token,
      refresh_token: decoded.refresh_token,
    })
  } catch (e) {
    console.warn('[sso] failed to consume handoff token', e)
  } finally {
    if (window.location.hash.includes('sso=')) {
      history.replaceState({}, document.title, window.location.pathname + window.location.search)
    }
  }
}

