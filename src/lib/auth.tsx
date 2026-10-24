// Keeps track of who is logged in, and logs people out after 12 hours without use.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { Role } from './format'

export interface Me {
  id: string
  name: string
  username: string
  role: Role
  email: string | null
  must_change_pin: boolean
}

interface AuthState {
  loading: boolean
  session: Session | null
  me: Me | null
  /** Why the person was logged out, shown on the login screen. */
  notice: string
  refreshMe: () => Promise<void>
  signOut: (notice?: string) => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

const IDLE_HOURS = 12
const LAST_ACTIVE = 'order-hub-last-active'

function touch() {
  try { localStorage.setItem(LAST_ACTIVE, String(Date.now())) } catch { /* private mode */ }
}
function idleTooLong(): boolean {
  try {
    const t = Number(localStorage.getItem(LAST_ACTIVE) ?? 0)
    return t > 0 && Date.now() - t > IDLE_HOURS * 3_600_000
  } catch {
    return false
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState<Session | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [notice, setNotice] = useState('')

  const signOut = useCallback(async (why = '') => {
    setNotice(why)
    setMe(null)
    await supabase.auth.signOut({ scope: 'local' })
  }, [])

  const loadMe = useCallback(async (s: Session | null) => {
    if (!s) {
      setMe(null)
      return
    }
    const { data } = await supabase.from('people').select('id, name, username, role, email, must_change_pin').eq('id', s.user.id).maybeSingle()
    if (!data) {
      await signOut('Your login has ended. Please log in again.')
      return
    }
    setMe(data as Me)
  }, [signOut])

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      if (data.session && idleTooLong()) {
        await signOut('You were logged out after 12 hours without use.')
      } else {
        setSession(data.session)
        await loadMe(data.session)
      }
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s)
      if (!s) setMe(null)
    })
    return () => sub.subscription.unsubscribe()
  }, [loadMe, signOut])

  // Count clicks and typing as "in use"; check now and then that the login is still valid
  // (7-day limit, or an admin switched the person off or reset their PIN).
  useEffect(() => {
    if (!session) return
    touch()
    const onUse = () => touch()
    window.addEventListener('pointerdown', onUse)
    window.addEventListener('keydown', onUse)
    const check = async () => {
      if (idleTooLong()) return signOut('You were logged out after 12 hours without use.')
      if (me && !me.must_change_pin) {
        const { data, error } = await supabase.rpc('me_ok')
        if (!error && data === false) signOut('Your login has ended. Please log in again.')
      }
    }
    const timer = window.setInterval(check, 5 * 60_000)
    window.addEventListener('focus', check)
    return () => {
      window.removeEventListener('pointerdown', onUse)
      window.removeEventListener('keydown', onUse)
      window.removeEventListener('focus', check)
      window.clearInterval(timer)
    }
  }, [session, me, signOut])

  const refreshMe = useCallback(async () => {
    const { data } = await supabase.auth.getSession()
    setSession(data.session)
    await loadMe(data.session)
  }, [loadMe])

  return <Ctx.Provider value={{ loading, session, me, notice, refreshMe, signOut }}>{children}</Ctx.Provider>
}

export function useAuth(): AuthState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}
