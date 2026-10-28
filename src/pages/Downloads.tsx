// Downloads: the evening Easy Ecom upload, new customers, per-order item files and the master list.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, ErrorBox, Input, OkBox, Select } from '../components/ui'
import { useAuth } from '../lib/auth'
import { fetchAll } from '../lib/catalog'
import { masterRows, newCustomerRows, offlineRows, problems, itemRows, toCsv, wholesaleRows, type EeOrder } from '../lib/easyecom'
import { rupees, todayIST } from '../lib/stages'
import { supabase } from '../lib/supabase'
import { StageBadge } from './Orders'

const COLS = `id, order_no, order_date, channel, stage, salesperson_id, customer_id, customer_name, contact_name, phone, email, gstin, fssai,
  billing_address, billing_city, billing_state, billing_pin, same_as_billing, delivery_name, delivery_address, delivery_city, delivery_state, delivery_pin,
  delivery_gstin, delivery_phone, po_number, po_date, payment_type, payment_terms, notes, invoice_no, invoice_date, invoice_value, shared_with,
  dispatch_date, courier, tracking_no, ee_uploaded_at, estimate_value,
  order_lines(line_no, sku, qty, rate, value, mrp, ean, gst_rate, hsn, tally_name, product_name),
  customer:customers(code, ee_customer_code, in_easy_ecom)`

function save(name: string, data: BlobPart, type: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([data], { type }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}
const csv = (name: string, rows: unknown[][]) => save(name, toCsv(rows), 'text/csv;charset=utf-8')

export default function Downloads() {
  const { me } = useAuth()
  const [orders, setOrders] = useState<EeOrder[] | null>(null)
  const [eeSkus, setEeSkus] = useState<Set<string>>(new Set())
  const [people, setPeople] = useState<Map<string, string>>(new Map())
  const [show, setShow] = useState('waiting')
  const [stages, setStages] = useState('sent')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [codes, setCodes] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const allowed = ['super_admin', 'admin', 'ops', 'accounts'].includes(me?.role ?? '')

  const load = useCallback(async () => {
    const [o, p, pp] = await Promise.all([
      fetchAll<EeOrder>('orders', COLS, (q) => q.not('invoice_no', 'is', null).neq('stage', 'cancelled').order('invoice_date').order('order_no')),
      fetchAll<{ sku: string }>('products', 'sku', (q) => q.eq('in_easy_ecom', true)),
      supabase.from('people').select('id, name'),
    ])
    o.forEach((x) => x.order_lines.sort((a, b) => a.line_no - b.line_no))
    setOrders(o)
    setEeSkus(new Set(p.map((x) => x.sku)))
    setPeople(new Map((pp.data ?? []).map((x) => [x.id, x.name])))
  }, [])
  useEffect(() => { load() }, [load])

  const list = useMemo(() => (orders ?? []).filter((o) => {
    if (show === 'waiting' && o.ee_uploaded_at) return false
    if (show === 'done' && !o.ee_uploaded_at) return false
    if (stages === 'sent' && !['dispatched', 'delivered'].includes(o.stage)) return false
    const d = o.dispatch_date ?? o.invoice_date ?? o.order_date
    if (from && d < from) return false
    if (to && d > to) return false
    return true
  }), [orders, show, stages, from, to])
  const ok = useMemo(() => list.filter((o) => !problems(o, eeSkus).length), [list, eeSkus])
  // Tick everything that is fine whenever the list changes.
  useEffect(() => { setPicked(new Set(ok.filter((o) => !o.ee_uploaded_at).map((o) => o.id))) }, [ok])
  const chosen = list.filter((o) => picked.has(o.id))
  const noCode = chosen.filter((o) => !o.customer?.ee_customer_code)
  const newCust = newCustomerRows(chosen).length - 1
  const day = todayIST()

  const saveCode = async (o: EeOrder) => {
    setError('')
    const { error: e } = await supabase.rpc('set_ee_customer_code', { p_customer: o.customer_id, p_code: codes[o.customer_id!] ?? '' })
    if (e) setError(e.message)
    else { setMsg(`Easy Ecom code saved for ${o.customer_name}.`); load() }
  }

  const zip = async () => {
    const { zipSync, strToU8 } = await import('fflate')
    const files = Object.fromEntries(chosen.map((o) => [`${o.order_no} ${o.customer_name.replace(/[^\w -]+/g, '').slice(0, 40)}.csv`, strToU8(toCsv(itemRows(o)))]))
    save(`easyecom-item-files-${day}.zip`, zipSync(files) as BlobPart, 'application/zip')
  }

  const master = async () => {
    const X = await import('xlsx')
    const wb = X.utils.book_new()
    X.utils.book_append_sheet(wb, X.utils.json_to_sheet(masterRows(chosen, people)), 'Orders')
    X.writeFile(wb, `master-list-${day}.xlsx`)
  }

  const markUploaded = async (undo = false) => {
    setBusy(true); setError(''); setMsg('')
    const ids = undo ? list.filter((o) => picked.has(o.id) && o.ee_uploaded_at).map((o) => o.id) : chosen.filter((o) => !o.ee_uploaded_at).map((o) => o.id)
    const { data, error: e } = await supabase.rpc('mark_ee_uploaded', { p_ids: ids, p_undo: undo })
    setBusy(false)
    if (e) { setError(e.message); return }
    setMsg(undo ? `${data} moved back to “not uploaded”.` : `${data} marked as uploaded to Easy Ecom.`)
    load()
  }

  const toggle = (id: string, v: boolean) => { const s = new Set(picked); if (v) s.add(id); else s.delete(id); setPicked(s) }
  const units = chosen.reduce((s, o) => s + o.order_lines.reduce((t, l) => t + l.qty, 0), 0)

  return (
    <div className="space-y-3 pb-24">
      <h2 className="text-xl font-bold text-ae-blue">Downloads</h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Select value={show} onChange={(e) => setShow(e.target.value)} aria-label="Show">
          <option value="waiting">Not in Easy Ecom</option><option value="done">Uploaded</option><option value="all">All</option>
        </Select>
        <Select value={stages} onChange={(e) => setStages(e.target.value)} aria-label="Stage">
          <option value="sent">Dispatched</option><option value="invoiced">Invoiced or later</option>
        </Select>
        <Input type="date" className="min-w-0" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <Input type="date" className="min-w-0" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
      </div>

      <Card className="space-y-3">
        <div className="text-sm text-stone-600"><b className="text-stone-900">{chosen.length}</b> orders · {units} units · {rupees(chosen.reduce((s, o) => s + Number(o.invoice_value ?? o.estimate_value), 0))}</div>
        <Button className="w-full" disabled={!chosen.length} onClick={() => csv(`easyecom-wholesale-${day}.csv`, wholesaleRows(chosen))}>⬇ Easy Ecom upload</Button>
        {noCode.length > 0 && <p className="text-xs text-amber-800">{noCode.length} without Easy Ecom customer code. Add it below first.</p>}
        <div className="grid grid-cols-2 gap-2">
          <Button tone="plain" disabled={!newCust} onClick={() => csv(`easyecom-new-customers-${day}.csv`, newCustomerRows(chosen))}>⬇ New customers ({newCust})</Button>
          <Button tone="plain" disabled={!chosen.length} onClick={master}>⬇ Master list</Button>
          <Button tone="plain" disabled={!chosen.length} onClick={() => csv(`easyecom-offline-import-${day}.csv`, offlineRows(chosen))}>⬇ Offline import</Button>
          <Button tone="plain" disabled={!chosen.length} onClick={zip}>⬇ Item files</Button>
        </div>
      </Card>

      <OkBox>{msg}</OkBox>
      <ErrorBox>{error}</ErrorBox>

      {!orders ? <p className="text-sm text-stone-500">Loading…</p> : !list.length ? <Card><p className="text-stone-600">Nothing here.</p></Card> : (
        <ul className="space-y-2">
          {list.map((o) => {
            const p = problems(o, eeSkus)
            return (
              <li key={o.id}>
                <Card className={`flex gap-3 p-3 sm:p-3 ${picked.has(o.id) ? 'border-ae-blue ring-2 ring-ae-blue/20' : ''}`}>
                  <input type="checkbox" className="mt-1 h-6 w-6 shrink-0 accent-ae-blue" checked={picked.has(o.id)} disabled={p.length > 0} onChange={(e) => toggle(o.id, e.target.checked)} />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                      <Link to={`/orders/${o.id}`} className="font-semibold text-stone-900 underline decoration-stone-300">{o.customer_name}</Link>
                      <span className="font-semibold">{rupees(o.invoice_value)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-stone-500">
                      {o.order_no} · {o.invoice_no} · {o.dispatch_date ?? 'not sent'} <StageBadge stage={o.stage as never} />
                      {o.ee_uploaded_at && <Badge tone="green">In Easy Ecom</Badge>}
                      {o.customer && !o.customer.in_easy_ecom && !o.customer.ee_customer_code && <Badge tone="amber">New customer</Badge>}
                    </div>
                    {p.map((x) => <div key={x} className="text-sm text-red-700">⚠ {x}{x.startsWith('Not in') && <> · <Link to="/products" className="underline">Products</Link></>}</div>)}
                    {allowed && o.customer_id && !o.customer?.ee_customer_code && (
                      <div className="flex gap-2 pt-1">
                        <Input className="min-h-10 text-sm" placeholder="Easy Ecom customer code" value={codes[o.customer_id] ?? ''} onChange={(e) => setCodes({ ...codes, [o.customer_id!]: e.target.value })} />
                        <Button tone="plain" className="min-h-10 px-3 text-sm" disabled={!codes[o.customer_id]?.trim()} onClick={() => saveCode(o)}>Save</Button>
                      </div>
                    )}
                  </div>
                </Card>
              </li>
            )
          })}
        </ul>
      )}

      {allowed && list.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-stone-200 bg-white/95 px-4 py-3 shadow-lg">
          <div className="mx-auto flex max-w-5xl justify-end gap-2">
            {show !== 'waiting' && <Button tone="plain" disabled={busy || !list.some((o) => picked.has(o.id) && o.ee_uploaded_at)} onClick={() => markUploaded(true)}>Undo</Button>}
            <Button disabled={busy || !chosen.some((o) => !o.ee_uploaded_at)} onClick={() => markUploaded()}>✓ Uploaded ({chosen.filter((o) => !o.ee_uploaded_at).length})</Button>
          </div>
        </div>
      )}
    </div>
  )
}
