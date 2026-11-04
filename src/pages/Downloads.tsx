// Easy Ecom Sync (the /downloads page): the evening Easy Ecom upload as four fixed options (components/EeSetup) and the
// dispatched orders they cover. Orders go in as Shipped retail orders, so Easy Ecom takes the stock off at once.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import EeSetup from '../components/EeSetup'
import { Badge, Button, Card, ErrorBox, Input, OkBox, Select } from '../components/ui'
import { useAuth } from '../lib/auth'
import { fetchAll } from '../lib/catalog'
import { MAX_ROWS, batches, inSalesReport, masterRows, offlineRows, problems, toCsv, unitsOf, type EeOrder } from '../lib/easyecom'
import { rupees, todayIST } from '../lib/stages'
import { supabase } from '../lib/supabase'
import { StageBadge } from './Orders'

const COLS = `id, order_no, order_date, channel, stage, salesperson_id, customer_id, customer_name, contact_name, phone, email, gstin, fssai,
  billing_address, billing_city, billing_state, billing_pin, same_as_billing, delivery_name, delivery_address, delivery_city, delivery_state, delivery_pin,
  delivery_gstin, delivery_phone, po_number, po_date, payment_type, payment_terms, notes, invoice_no, invoice_date, invoice_value, shared_with,
  dispatch_date, courier, tracking_no, ee_uploaded_at, ee_file_at, estimate_value, shipping_charge, packaging_charge,
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
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [parts, setParts] = useState<EeOrder[][] | null>(null)
  const [found, setFound] = useState<EeOrder[] | null>(null)
  const reportRef = useRef<HTMLInputElement>(null)
  const allowed = ['super_admin', 'admin', 'manager', 'ops', 'accounts'].includes(me?.role ?? '')

  const load = useCallback(async () => {
    const [o, p, pp] = await Promise.all([
      fetchAll<EeOrder>('orders', COLS, (q) => q.or('invoice_no.not.is.null,channel.eq.FOC').neq('stage', 'cancelled').order('invoice_date').order('order_no')),
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
    if (!['dispatched', 'delivered'].includes(o.stage)) return false
    const d = o.dispatch_date ?? o.invoice_date ?? o.order_date
    if (from && d < from) return false
    if (to && d > to) return false
    return true
  }), [orders, show, from, to])
  const ok = useMemo(() => list.filter((o) => !problems(o, eeSkus).length), [list, eeSkus])
  // Tick everything that is fine whenever the list changes, except orders already put in a file.
  useEffect(() => { setPicked(new Set(ok.filter((o) => !o.ee_uploaded_at && !o.ee_file_at).map((o) => o.id))) }, [ok])
  const inFile = list.filter((o) => !o.ee_uploaded_at && o.ee_file_at)
  const chosen = list.filter((o) => picked.has(o.id))
  const day = todayIST()

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

  const rpc = async (name: string, args: Record<string, unknown>, done: string) => {
    setBusy(true); setError(''); setMsg('')
    const { data, error: e } = await supabase.rpc(name, args)
    setBusy(false)
    if (e) { setError(e.message); return false }
    setMsg(done.replace('N', String(data))); load()
    return true
  }
  // Easy Ecom takes under 2,000 rows a file, so big days come as numbered parts, each ticked on its own.
  const makeFiles = () => {
    const todo = chosen.filter((o) => !o.ee_uploaded_at)
    const p = batches(todo)
    if (p.length === 1) { downloadPart(p[0], ''); setParts(null) } else setParts(p)
  }
  const downloadPart = (p: EeOrder[], suffix: string) => {
    csv(`easyecom-shipped-orders-${day}${suffix}.csv`, offlineRows(p))
    supabase.rpc('mark_ee_file', { p_ids: p.map((o) => o.id) }).then(() => load())
  }
  const checkReport = async (f: File) => {
    setError(''); setMsg('')
    try {
      const X = await import('xlsx')
      const wb = X.read(await f.arrayBuffer(), { type: 'array' })
      const rows = X.utils.sheet_to_json<Record<string, string>>(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false })
      if (!rows.length || !('Reference Code' in rows[0])) throw new Error('Please choose Easy Ecom’s sales report (CSV).')
      setFound(inSalesReport((orders ?? []).filter((o) => !o.ee_uploaded_at), rows))
    } catch (e) { setError((e as Error).message) }
  }

  const toggle = (id: string, v: boolean) => { const s = new Set(picked); if (v) s.add(id); else s.delete(id); setPicked(s) }
  const units = chosen.reduce((s, o) => s + o.order_lines.reduce((t, l) => t + l.qty, 0), 0)

  return (
    <div className="space-y-3 pb-24">
      <h2 className="text-xl font-bold text-ae-blue">Easy Ecom Sync</h2>
      <div className="grid grid-cols-3 gap-2">
        <Select value={show} onChange={(e) => setShow(e.target.value)} aria-label="Show">
          <option value="waiting">Not in Easy Ecom</option><option value="done">Uploaded</option><option value="all">All</option>
        </Select>
        <Input type="date" className="min-w-0" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <Input type="date" className="min-w-0" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
      </div>

      {orders && (
        <EeSetup orders={list} eeSkus={eeSkus} day={day} save={(n, d) => save(n, d, 'text/csv;charset=utf-8')} onChange={load}
          ready={chosen.filter((o) => !o.ee_uploaded_at).length} total={list.filter((o) => !o.ee_uploaded_at && !o.ee_file_at).length}
          onOrders={makeFiles} />
      )}

      {allowed && (
        <div className="text-sm">
          <button type="button" className="font-semibold text-ae-blue underline" onClick={() => reportRef.current?.click()}>Check Easy Ecom report</button>
          <input ref={reportRef} type="file" accept=".csv,.xlsx" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) checkReport(f) }} />
        </div>
      )}
      {found && (
        <Card className="space-y-2 border-amber-300 bg-amber-50 p-3">
          {found.length ? <>
            <p className="text-sm font-semibold text-amber-900">Already in Easy Ecom: {found.map((o) => o.order_no).join(', ')}</p>
            <div className="flex gap-2">
              <Button className="min-h-10 px-3 text-sm" disabled={busy} onClick={async () => { if (await rpc('mark_ee_uploaded', { p_ids: found.map((o) => o.id) }, 'N marked as uploaded.')) setFound(null) }}>✓ Mark {found.length} uploaded</Button>
              <Button tone="plain" className="min-h-10 px-3 text-sm" onClick={() => setFound(null)}>Close</Button>
            </div>
          </> : <div className="flex items-center justify-between gap-2"><p className="text-sm text-stone-700">None of the waiting orders are in this report.</p><Button tone="plain" className="min-h-10 px-3 text-sm" onClick={() => setFound(null)}>Close</Button></div>}
        </Card>
      )}

      {parts && (
        <Card className="space-y-2 border-ae-blue/30 p-3">
          <p className="text-sm font-semibold text-ae-blue">{parts.length} files: Easy Ecom takes {MAX_ROWS.toLocaleString('en-IN')} rows at a time. Upload one, wait for it to finish, then ✓ it.</p>
          <ul className="divide-y divide-stone-100">
            {parts.map((p, i) => {
              const done = p.every((o) => (orders ?? []).find((x) => x.id === o.id)?.ee_uploaded_at)
              return (
                <li key={i} className="flex flex-wrap items-center gap-2 py-2">
                  <Button tone="plain" className="min-h-10 px-3 text-sm" disabled={done} onClick={() => downloadPart(p, `-part${i + 1}of${parts.length}`)}>⬇ Part {i + 1} of {parts.length}</Button>
                  <span className="text-sm text-stone-600">{p.length} orders · {p.reduce((t, o) => t + unitsOf(o), 0)} rows</span>
                  {done ? <Badge tone="green">Uploaded</Badge> : <Button className="ml-auto min-h-10 px-3 text-sm" disabled={busy} onClick={() => rpc('mark_ee_uploaded', { p_ids: p.map((o) => o.id) }, 'N marked as uploaded.')}>✓ Part {i + 1} uploaded</Button>}
                </li>
              )
            })}
          </ul>
          <Button tone="plain" className="min-h-9 px-3 text-sm" onClick={() => setParts(null)}>Close</Button>
        </Card>
      )}

      {inFile.length > 0 && (
        <Card className="space-y-2 border-amber-300 bg-amber-50 p-3">
          <p className="text-sm font-semibold text-amber-900">In an earlier file, not ticked: {inFile.map((o) => o.order_no).join(', ')}</p>
          <p className="text-xs text-amber-900">Check Easy Ecom first. Left out of new files until you choose.</p>
          <div className="flex flex-wrap gap-2">
            <Button className="min-h-10 px-3 text-sm" disabled={busy} onClick={() => rpc('mark_ee_uploaded', { p_ids: inFile.map((o) => o.id) }, 'N marked as uploaded.')}>✓ They're in Easy Ecom</Button>
            <Button tone="plain" className="min-h-10 px-3 text-sm" disabled={busy} onClick={() => rpc('mark_ee_file', { p_ids: inFile.map((o) => o.id), p_undo: true }, 'N put back for the next file.')}>Put back</Button>
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-stone-600">
        <span><b className="text-stone-900">{chosen.length}</b> ticked · {units} units · {rupees(chosen.reduce((s, o) => s + Number(o.invoice_value ?? o.estimate_value), 0))}</span>
        <button type="button" className="underline disabled:opacity-40" disabled={!chosen.length} onClick={master}>Master list</button>
      </div>

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
                      {o.ee_uploaded_at ? <Badge tone="green">In Easy Ecom</Badge> : o.ee_file_at && <Badge tone="amber">In a file</Badge>}
                    </div>
                    {p.map((x) => <div key={x} className="text-sm text-red-700">⚠ {x}{x.startsWith('Not in') && <> · <Link to="/products" className="underline">Products</Link></>}</div>)}
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
