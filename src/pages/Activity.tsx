// Who did what, when. Admins also see a "Logins" tab with logins, wrong PINs and locks.
import { useEffect, useState } from 'react'
import { Badge, Card } from '../components/ui'
import { useAuth } from '../lib/auth'
import { isAdmin, istDateTime } from '../lib/format'
import { supabase } from '../lib/supabase'

interface ActivityRow { id: number; at: string; summary: string; person: { name: string } | null }
interface LoginRow { id: number; at: string; kind: string; username_tried: string | null; ip: string | null; user_agent: string | null; person: { name: string } | null }

const LOGIN_KINDS: Record<string, { label: string; tone: 'green' | 'red' | 'amber' | 'stone' }> = {
  login_success: { label: 'Logged in', tone: 'green' },
  login_failed: { label: 'Wrong name or PIN', tone: 'amber' },
  locked: { label: 'Locked', tone: 'red' },
  pin_changed: { label: 'PIN changed', tone: 'stone' },
  change_pin_failed: { label: 'PIN change: wrong current PIN', tone: 'amber' },
  pin_reset_requested: { label: 'PIN reset code asked for', tone: 'stone' },
  pin_reset: { label: 'PIN reset by email code', tone: 'stone' },
}

function device(ua: string | null) {
  if (!ua) return ''
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : ''
  return os
}

export default function Activity() {
  const { me } = useAuth()
  const [tab, setTab] = useState<'changes' | 'logins'>('changes')
  const [rows, setRows] = useState<ActivityRow[]>([])
  const [logins, setLogins] = useState<LoginRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    if (tab === 'changes') {
      supabase.from('activity').select('id, at, summary, person:people(name)').order('at', { ascending: false }).limit(300)
        .then(({ data }) => { setRows((data ?? []) as unknown as ActivityRow[]); setLoading(false) })
    } else {
      supabase.from('login_events').select('id, at, kind, username_tried, ip, user_agent, person:people(name)').order('at', { ascending: false }).limit(300)
        .then(({ data }) => { setLogins((data ?? []) as unknown as LoginRow[]); setLoading(false) })
    }
  }, [tab])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-bold text-stone-800">Activity</h2>
        {isAdmin(me?.role) && (
          <div className="flex rounded-lg border border-stone-300 bg-white p-1 text-sm font-semibold">
            {(['changes', 'logins'] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTab(t)} className={`rounded-md px-3 py-1.5 ${tab === t ? 'bg-amber-600 text-white' : 'text-stone-600'}`}>
                {t === 'changes' ? 'Changes' : 'Logins'}
              </button>
            ))}
          </div>
        )}
      </div>
      <Card className="p-0 sm:p-0">
        {loading ? (
          <p className="p-4 text-sm text-stone-500">Loading…</p>
        ) : tab === 'changes' ? (
          rows.length ? (
            <ul className="divide-y divide-stone-100">
              {rows.map((r) => (
                <li key={r.id} className="px-4 py-3">
                  <div className="text-sm text-stone-800">{r.summary}</div>
                  <div className="text-xs text-stone-500">{istDateTime(r.at)}</div>
                </li>
              ))}
            </ul>
          ) : <p className="p-4 text-sm text-stone-500">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-stone-100">
            {logins.map((r) => {
              const k = LOGIN_KINDS[r.kind] ?? { label: r.kind, tone: 'stone' as const }
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
                  <Badge tone={k.tone}>{k.label}</Badge>
                  <span className="font-semibold text-stone-800">{r.person?.name ?? (r.username_tried ? `“${r.username_tried}”` : '—')}</span>
                  <span className="text-xs text-stone-500">{istDateTime(r.at)} · {device(r.user_agent)} {r.ip}</span>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}
