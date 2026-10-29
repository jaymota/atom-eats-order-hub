// Invoice register: every invoice, who it was shared with, and whether it has left.
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Card, Input, Select } from '../components/ui'
import { CHANNELS } from '../lib/channels'
import { fetchAll } from '../lib/catalog'
import { norm } from '../lib/match'
import { rupees, todayIST } from '../lib/stages'

interface Inv {
  id: string; order_no: string; invoice_no: string; invoice_date: string; invoice_value: number
  customer_name: string; gstin: string | null; channel: string; stage: string; dispatch_date: string | null; courier: string | null; tracking_no: string | null
}

const sent = (r: Inv) => ['dispatched', 'delivered'].includes(r.stage)
const day = (d: string) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })

export default function Invoices() {
  const [rows, setRows] = useState<Inv[] | null>(null)
  const [q, setQ] = useState('')
  const [from, setFrom] = useState(todayIST().slice(0, 8) + '01')
  const [to, setTo] = useState('')
  const [channel, setChannel] = useState('')
  const [status, setStatus] = useState('')

  useEffect(() => {
    fetchAll<Inv>('orders', 'id, order_no, invoice_no, invoice_date, invoice_value, customer_name, gstin, channel, stage, dispatch_date, courier, tracking_no',
      (x) => x.not('invoice_no', 'is', null).neq('stage', 'cancelled').order('invoice_date', { ascending: false }).order('invoice_no', { ascending: false })).then(setRows)
  }, [])

  const list = useMemo(() => (rows ?? []).filter((r) => {
    if (from && r.invoice_date < from) return false
    if (to && r.invoice_date > to) return false
    if (channel && r.channel !== channel) return false
    if (status === 'waiting' && sent(r)) return false
    if (status === 'sent' && !sent(r)) return false
    if (q && !norm(`${r.invoice_no} ${r.order_no} ${r.customer_name} ${r.tracking_no ?? ''}`).includes(norm(q))) return false
    return true
  }), [rows, q, from, to, channel, status])
  const total = list.reduce((s, r) => s + Number(r.invoice_value), 0)
  const waiting = list.filter((r) => !sent(r)).length

  const download = async () => {
    const X = await import('xlsx')
    const ws = X.utils.json_to_sheet(list.map((r) => ({
      'Invoice no.': r.invoice_no, 'Invoice date': r.invoice_date, 'Value': Number(r.invoice_value), 'Customer': r.customer_name, 'GSTIN': r.gstin ?? '',
      'Channel': r.channel, 'Order no.': r.order_no,
      'Dispatched': sent(r) ? 'Yes' : 'Not yet', 'Dispatch date': r.dispatch_date ?? '', 'Courier': r.courier ?? '', 'Tracking': r.tracking_no ?? '',
    })))
    const wb = X.utils.book_new()
    X.utils.book_append_sheet(wb, ws, 'Invoices')
    X.writeFile(wb, `invoices-${from || 'all'}-to-${to || todayIST()}.xlsx`)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-bold text-ae-blue">All invoices</h2>
        <Button tone="plain" disabled={!list.length} onClick={download}>⬇ Excel</Button>
      </div>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        <Select value={channel} onChange={(e) => setChannel(e.target.value)}><option value="">All channels</option>{CHANNELS.map((c) => <option key={c}>{c}</option>)}</Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="waiting">Not dispatched</option><option value="sent">Dispatched</option></Select>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <Card className="p-3 sm:p-3"><div className="text-2xl font-bold text-ae-blue">{list.length}</div><div className="text-xs text-stone-500">Invoices</div></Card>
        <Card className="p-3 sm:p-3"><div className="text-2xl font-bold text-ae-blue">{rupees(Math.round(total))}</div><div className="text-xs text-stone-500">Value</div></Card>
        <Card className="p-3 sm:p-3"><div className={`text-2xl font-bold ${waiting ? 'text-red-700' : 'text-ae-blue'}`}>{waiting}</div><div className="text-xs text-stone-500">Not dispatched</div></Card>
      </div>
      {!rows ? <p className="text-sm text-stone-500">Loading…</p> : !list.length ? <Card><p className="text-stone-600">No invoices.</p></Card> : (
        <Card className="overflow-x-auto p-0 sm:p-0">
          <table className="w-full text-left text-sm">
            <thead className="bg-ae-cream/60 text-xs uppercase text-stone-500">
              <tr>{['Invoice', 'Date', 'Customer', 'Value', 'Dispatch'].map((h) => <th key={h} className="whitespace-nowrap px-3 py-2">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {list.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap px-3 py-2"><Link to={`/orders/${r.id}`} className="font-semibold text-ae-blue underline">{r.invoice_no}</Link></td>
                  <td className="whitespace-nowrap px-3 py-2">{day(r.invoice_date)}</td>
                  <td className="px-3 py-2">{r.customer_name}<div className="text-xs text-stone-500">{r.channel}</div></td>
                  <td className="whitespace-nowrap px-3 py-2">{rupees(r.invoice_value)}</td>
                  <td className="px-3 py-2">{sent(r) ? <span className="text-green-800">{r.courier} {r.tracking_no}</span> : <span className="font-semibold text-red-700">Not yet</span>}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="border-t-2 border-stone-200 font-semibold"><td className="px-3 py-2" colSpan={3}>Total</td><td className="whitespace-nowrap px-3 py-2">{rupees(total)}</td><td /></tr></tfoot>
          </table>
        </Card>
      )}
    </div>
  )
}
