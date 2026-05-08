import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const runtimeEnv = (globalThis as any).__ANIMA_ENV__ ?? {}
const supabaseUrl =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ||
  (import.meta.env.VITE_PUBLIC_SUPABASE_URL as string | undefined) ||
  runtimeEnv.SUPABASE_URL
const supabaseAnonKey =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ||
  (import.meta.env.VITE_PUBLIC_SUPABASE_ANON_KEY as string | undefined) ||
  runtimeEnv.SUPABASE_ANON_KEY

function createSupabaseClient(): SupabaseClient {
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error(
      'Missing Supabase environment variables (SUPABASE_URL, SUPABASE_ANON_KEY or VITE aliases). ' +
      'Database features will not work.'
    )
    return createClient('https://placeholder.supabase.co', 'placeholder')
  }
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      storageKey: 'wa-auth',
      storage: localStorage,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      // Implicit flow avoids PKCE code_verifier coupling across apps/devices,
      // which is critical for email-confirmation links opened from mail clients.
      flowType: 'implicit',
    },
  })
}

export const supabase = createSupabaseClient()
