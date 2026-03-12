import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

function createSupabaseClient(): SupabaseClient {
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error(
      'Missing Supabase environment variables (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY). ' +
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
      // PKCE flow: magic link returns a code param instead of hash fragment.
      // This works reliably in PWA standalone mode because the redirect
      // goes through a normal URL (not a hash), which iOS can handle.
      flowType: 'pkce',
    },
  })
}

export const supabase = createSupabaseClient()
