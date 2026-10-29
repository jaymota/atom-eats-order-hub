// Home: the to-do tiles and the warnings. (Charts and stock come in Phase 7.)
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '../components/ui'
import { useAuth } from '../lib/auth'
import { fetchAll } from '../lib/catalog'
import { age, isLate, todayIST, type Stage } from '../lib/stages'
import { useTodoCounts } from '../lib/todo'

interface O { id: string; order_no: string; customer_name: string; stage: Stage; received_at: string; planned_at: string | null; invoiced_at: string | null; dispatch_date: string | null; missing: string[] }

const H24 = 24 * 3_600_000
const older = (iso: string | null) => !!iso && Date.now() - Date.parse(iso) > H24

export default function Home() {
  const { me } = useAuth()
  const [rows, setRows] = useState<O[] | null>(null)
  const counts = useTodoCounts()
  useEffect(() => {
    fetchAll<O>('orders', 'id, order_no, customer_name, stage, received_at, planned_at, invoiced_at, dispatch_date, missing',
      (q) => q.or(`stage.in.(new,planned,invoiced,on_hold),dispatch_date.eq.${todayIST()}`).order('received_at')).then(setRows)
  }, [])
  if (!me) return null
  const r = rows ?? []
  const n = (s: Stage) => r.filter((o) => o.stage === s).length
  const tiles = [
    ...(counts?.confirm ? [{ to: '/inbox', label: 'To confirm', n: counts.confirm }] : []),
    { to: '/plan', label: 'Plan', n: n('new') },
    { to: '/invoice', label: 'Invoice', n: n('planned') },
    { to: '/dispatch', label: 'Dispatch', n: n('invoiced') },
    { to: '/orders', label: 'Sent today', n: r.filter((o) => o.dispatch_date === todayIST()).length },
  ]
  const warnings = [
    { label: 'Late', list: r.filter((o) => isLate(o.stage, o.received_at)) },
    { label: 'Invoiced, not sent (24 h+)', list: r.filter((o) => o.stage === 'invoiced' && older(o.invoiced_at)) },
    { label: 'Planned, no invoice (24 h+)', list: r.filter((o) => o.stage === 'planned' && older(o.planned_at)) },
    { label: 'Missing info', list: r.filter((o) => o.stage === 'new' && o.missing.length) },
  ].filter((w) => w.list.length)

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-ae-blue">Hello, {me.name.split(' ')[0]}</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map((t) => (
          <Link key={t.label} to={t.to} className="rounded-2xl border-2 border-ae-blue/20 bg-white p-4 text-center shadow-sm active:bg-ae-blue/5">
            <div className="text-4xl font-bold text-ae-blue">{rows ? t.n : '…'}</div>
            <div className="mt-1 font-semibold text-stone-700">{t.label}</div>
          </Link>
        ))}
      </div>
      {warnings.map((w) => (
        <Card key={w.label} className="border-red-200 bg-red-50/50">
          <h3 className="mb-1 font-semibold text-red-800">⚠ {w.label} ({w.list.length})</h3>
          <ul className="space-y-1 text-sm">
            {w.list.slice(0, 6).map((o) => (
              <li key={o.id}><Link to={`/orders/${o.id}`} className="text-stone-800 underline decoration-stone-300">{o.customer_name}</Link> <span className="text-xs text-stone-500">{o.order_no} · {age(o.received_at)}</span></li>
            ))}
            {w.list.length > 6 && <li className="text-xs text-stone-500">+{w.list.length - 6} more</li>}
          </ul>
        </Card>
      ))}
      {rows && !warnings.length && <p className="text-sm text-green-800">✓ No warnings.</p>}
    </div>
  )
}
