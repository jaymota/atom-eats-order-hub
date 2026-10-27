// How many orders wait at each to-do list (for the menu badges and the home screen).
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { supabase } from './supabase'

export interface TodoCounts { plan: number; invoice: number; dispatch: number }

export async function loadTodoCounts(): Promise<TodoCounts> {
  const c = (stage: string) => supabase.from('orders').select('id', { count: 'exact', head: true }).eq('stage', stage)
  const [a, b, d] = await Promise.all([c('new'), c('planned'), c('invoiced')])
  return { plan: a.count ?? 0, invoice: b.count ?? 0, dispatch: d.count ?? 0 }
}

/** Tell the menu badges to count again (after an order moves on). */
export const todoChanged = () => window.dispatchEvent(new Event('todo-changed'))

/** Refreshed on every page change and after every stage change. */
export function useTodoCounts(): TodoCounts | null {
  const loc = useLocation()
  const [n, setN] = useState<TodoCounts | null>(null)
  useEffect(() => {
    const go = () => { loadTodoCounts().then(setN).catch(() => {}) }
    go()
    window.addEventListener('todo-changed', go)
    return () => window.removeEventListener('todo-changed', go)
  }, [loc.pathname, loc.key])
  return n
}
