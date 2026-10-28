// Every offline order in one list, newest first.
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, Input, Select } from '../components/ui'
import { fetchAll } from '../lib/catalog'
import { norm } from '../lib/match'
import { STAGE_LABEL, STAGE_TONE, age, isLate, rupees, type Stage } from '../lib/stages'
import { supabase } from '../lib/supabase'
import { CHANNELS } from './Customers'

export interface OrderRow {
  id: string
  order_no: string
  order_date: string
  received_at: string
  stage: Stage
  channel: string
  customer_name: string
  billing_city: string | null
  delivery_city: string | null
  estimate_value: number
  invoice_value: number | null
  invoice_no: string | null
  po_number: string | null
  courier: string | null
  tracking_no: string | null
  missing: string[]
  salesperson_id: string | null
  order_lines: { product_name: string | null; qty: number }[]
}

export const ORDER_LIST_COLS = 'id, order_no, order_date, received_at, stage, channel, customer_name, billing_city, delivery_city, estimate_value, invoice_value, invoice_no, po_number, courier, tracking_no, missing, salesperson_id, order_lines(product_name, qty)'

export function StageBadge({ stage }: { stage: Stage }) {
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${STAGE_TONE[stage]}`}>{STAGE_LABEL[stage]}</span>
}

export function itemsShort(lines: { product_name: string | null; qty: number }[]): string {
  const s = lines.map((l) => `${l.qty}× ${(l.product_name ?? '').replace(/ - Pack of 1/i, '').split(' · ')[0]}`)
  return s.length > 3 ? `${s.slice(0, 3).join(', ')} +${s.length - 3} more` : s.join(', ')
}

/** The full order list. `embedded` = inside Plan / Invoice / Dispatch (no heading). */
export default function Orders({ embedded = false }: { embedded?: boolean }) {
  const [rows, setRows] = useState<OrderRow[]>([])
  const [people, setPeople] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [stage, setStage] = useState(embedded ? 'all' : 'open')
  const [channel, setChannel] = useState('')
  const [person, setPerson] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [lateOnly, setLateOnly] = useState(false)
  const [missingOnly, setMissingOnly] = useState(false)

  useEffect(() => {
    Promise.all([
      fetchAll<OrderRow>('orders', ORDER_LIST_COLS, (x) => x.order('received_at', { ascending: false })),
      supabase.from('people').select('id, name'),
    ]).then(([o, p]) => {
      setRows(o)
      setPeople(new Map((p.data ?? []).map((x) => [x.id, x.name])))
      setLoading(false)
    })
  }, [])

  const list = useMemo(() => {
    const qn = norm(q)
    return rows.filter((r) => {
      if (stage === 'open' && ['dispatched', 'delivered', 'cancelled'].includes(r.stage)) return false
      if (stage !== 'open' && stage !== 'all' && r.stage !== stage) return false
      if (channel && r.channel !== channel) return false
      if (person && r.salesperson_id !== person) return false
      if (from && r.order_date < from) return false
      if (to && r.order_date > to) return false
      if (lateOnly && !isLate(r.stage, r.received_at)) return false
      if (missingOnly && !r.missing.length) return false
      if (qn && !norm(`${r.order_no} ${r.customer_name} ${r.po_number ?? ''} ${r.invoice_no ?? ''} ${r.tracking_no ?? ''}`).includes(qn)) return false
      return true
    })
  }, [rows, q, stage, channel, person, from, to, lateOnly, missingOnly])

  return (
    <div className="space-y-4">
      {!embedded && (
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-xl font-bold text-ae-blue">Orders</h2>
          <Link to="/orders/new"><Button>+ New order</Button></Link>
        </div>
      )}
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search: customer, order no., PO no., invoice no., tracking no." />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Select value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="open">Not yet dispatched</option>
          <option value="all">All stages</option>
          {(Object.keys(STAGE_LABEL) as Stage[]).map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
        </Select>
        <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="">All channels</option>
          {CHANNELS.map((c) => <option key={c}>{c}</option>)}
        </Select>
        <Select value={person} onChange={(e) => setPerson(e.target.value)}>
          <option value="">Everyone</option>
          {[...people].map(([id, n]) => <option key={id} value={id}>{n}</option>)}
        </Select>
        <div className="col-span-2 flex gap-2 sm:col-span-1">
          <Input type="date" className="min-w-0" value={from} onChange={(e) => setFrom(e.target.value)} title="From" />
          <Input type="date" className="min-w-0" value={to} onChange={(e) => setTo(e.target.value)} title="To" />
        </div>
      </div>
      <div className="flex flex-wrap gap-4 text-sm font-semibold text-stone-700">
        <label className="flex items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={lateOnly} onChange={(e) => setLateOnly(e.target.checked)} /> Late only</label>
        <label className="flex items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} /> Missing info only</label>
      </div>

      {loading ? <p className="text-sm text-stone-500">Loading…</p> : !list.length ? (
        <Card><p className="text-sm text-stone-600">{rows.length ? 'No orders match these filters.' : 'No orders yet. Press “+ New order” to enter the first one.'}</p></Card>
      ) : (
        <Card className="p-0 sm:p-0">
          <div className="border-b border-stone-100 px-4 py-2 text-xs text-stone-500">{list.length} orders</div>
          {/* Phone: cards. Computer: a table. */}
          <ul className="divide-y divide-stone-100 md:hidden">
            {list.map((r) => {
              const late = isLate(r.stage, r.received_at)
              return (
                <li key={r.id}>
                  <Link to={`/orders/${r.id}`} className="block space-y-1 px-4 py-3 hover:bg-ae-cream/40">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-stone-900">{r.customer_name}</span>
                      <StageBadge stage={r.stage} />
                    </div>
                    <div className="text-xs text-stone-500">{r.order_no} · {r.channel} · {r.delivery_city ?? r.billing_city ?? ''} · {rupees(r.invoice_value ?? r.estimate_value)}</div>
                    <div className="text-sm text-stone-700">{itemsShort(r.order_lines)}</div>
                    <div className="flex flex-wrap gap-1.5">
                      <span className={`text-xs font-semibold ${late ? 'text-red-700' : 'text-stone-500'}`}>{late ? 'LATE · ' : ''}{age(r.received_at)}</span>
                      {r.missing.length > 0 && <Badge tone="amber">Missing: {r.missing.length}</Badge>}
                      {r.invoice_no && <Badge>{r.invoice_no}</Badge>}
                    </div>
                  </Link>
                </li>
              )
            })}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-left text-sm">
              <thead className="bg-ae-cream/60 text-xs uppercase text-stone-500">
                <tr>{['Order', 'Date', 'Channel', 'Customer', 'City', 'Items', 'Value', 'Stage', 'Invoice', 'Dispatch', 'Age'].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {list.map((r) => {
                  const late = isLate(r.stage, r.received_at)
                  return (
                    <tr key={r.id} className="hover:bg-ae-cream/40">
                      <td className="px-3 py-2"><Link to={`/orders/${r.id}`} className="font-semibold text-ae-blue underline">{r.order_no}</Link></td>
                      <td className="whitespace-nowrap px-3 py-2">{new Date(r.order_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</td>
                      <td className="px-3 py-2">{r.channel}</td>
                      <td className="px-3 py-2 font-semibold">{r.customer_name}{r.missing.length > 0 && <span className="ml-1"><Badge tone="amber">Missing {r.missing.length}</Badge></span>}</td>
                      <td className="px-3 py-2">{r.delivery_city ?? r.billing_city ?? '—'}</td>
                      <td className="max-w-64 px-3 py-2 text-stone-600">{itemsShort(r.order_lines)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{rupees(r.invoice_value ?? r.estimate_value)}{r.invoice_value == null && <span className="text-xs text-stone-400"> est.</span>}</td>
                      <td className="px-3 py-2"><StageBadge stage={r.stage} /></td>
                      <td className="px-3 py-2">{r.invoice_no ?? '—'}</td>
                      <td className="px-3 py-2">{r.tracking_no ? `${r.courier ?? ''} ${r.tracking_no}` : r.courier ?? '—'}</td>
                      <td className={`whitespace-nowrap px-3 py-2 ${late ? 'font-semibold text-red-700' : 'text-stone-500'}`}>{age(r.received_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
