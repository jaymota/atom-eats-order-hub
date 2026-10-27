import { createClient } from '@supabase/supabase-js'

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string
export const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string

// The publishable key is safe in the browser: Row Level Security decides what it can see.
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'order-hub-session' },
})

/** Call one of our Edge Functions. Throws an Error with a friendly message on failure. */
export async function callFn<T = Record<string, unknown>>(name: 'auth' | 'team' | 'notify', body: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY }
  const needsLogin = name !== 'auth' || ['change_pin', 'logout_everywhere'].includes(String(body.action))
  if (needsLogin) {
    const { data: s } = await supabase.auth.getSession()
    if (s.session?.access_token) headers.Authorization = `Bearer ${s.session.access_token}`
  }
  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, { method: 'POST', headers, body: JSON.stringify(body) })
  } catch {
    throw new Error('No internet connection. Please check and try again.')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data?.error ?? `Something went wrong (${res.status})`) as Error & { data?: unknown; status?: number }
    err.data = data
    err.status = res.status
    throw err
  }
  return data as T
}
