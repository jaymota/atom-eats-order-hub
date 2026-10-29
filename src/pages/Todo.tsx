// The three to-do lists: Plan (ops), Invoice (accounts), Dispatch (ops). Many orders at once.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Badge, Button, Card, ErrorBox, Input, OkBox, Select } from '../components/ui'
import { useAuth } from '../lib/auth'
import { COURIERS, age, attachFile, can, isLate, notify, rupees, todayIST, type Stage } from '../lib/stages'
import { supabase } from '../lib/supabase'
import { todoChanged } from '../lib/todo'
import Orders, { itemsShort } from './Orders'

interface Row {
  id: string; order_no: string; received_at: string; stage: Stage; channel: string; customer_name: string
  gstin: string | null; delivery_city: string | null; billing_city: string | null; estimate_value: number; missing: string[]
  po_number: string | null; courier_pref: string | null; planned_by: string | null; invoice_no: string | null; invoice_value: number | null
  shipping_charge: number; courier: string | null; tracking_no: string | null; boxes: number | null; dispatch_note: string | null; dispatch_date: string | null
  order_lines: { product_name: string | null; qty: number; tally_name: string | null; rate: number | null; sku: string }[]
}
const COLS = 'id, order_no, received_at, stage, channel, customer_name, gstin, delivery_city, billing_city, estimate_value, missing, po_number, courier_pref, planned_by, invoice_no, invoice_value, shipping_charge, courier, tracking_no, boxes, dispatch_note, dispatch_date, order_lines(product_name, qty, tally_name, rate, sku, line_no)'

function useStageRows(stage: Stage | 'no_tracking') {
  const [rows, setRows] = useState<Row[] | null>(null)
  const load = useCallback(async () => {
    let q = supabase.from('orders').select(COLS)
    // Dispatched (or delivered) without a docket number, except customer pickups.
    q = stage === 'no_tracking' ? q.in('stage', ['dispatched', 'delivered']).is('tracking_no', null).neq('courier', 'Customer pickup') : q.eq('stage', stage)
    const { data } = await q.order('received_at').order('line_no', { referencedTable: 'order_lines' })
    setRows((data ?? []) as unknown as Row[])
    todoChanged()
  }, [stage])
  useEffect(() => { load() }, [load])
  return { rows, load }
}

function Head({ o }: { o: Row }) {
  const late = isLate(o.stage, o.received_at)
  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <Link to={`/orders/${o.id}`} className="font-semibold text-stone-900 underline decoration-stone-300">{o.customer_name}</Link>
        <span className="font-semibold">{rupees(o.invoice_value ?? o.estimate_value)}</span>
      </div>
      <div className="text-xs text-stone-500">
        {o.order_no} · {o.channel} · {o.delivery_city ?? o.billing_city ?? ''} · <span className={late ? 'font-semibold text-red-700' : ''}>{late ? 'LATE ' : ''}{age(o.received_at)}</span>
      </div>
    </div>
  )
}

/** To do / All orders (/ No tracking) switch at the top of each to-do page. */
function Tabs({ tabs, on, set }: { tabs: [string, string][]; on: string; set: (k: string) => void }) {
  return (
    <div className="flex rounded-xl border border-ae-blue/20 bg-white p-1">
      {tabs.map(([k, label]) => (
        <button key={k} type="button" onClick={() => set(k)}
          className={`min-h-11 flex-1 rounded-lg px-2 text-sm font-semibold ${on === k ? 'bg-ae-blue text-ae-cream' : 'text-stone-600'}`}>{label}</button>
      ))}
    </div>
  )
}

function Shell({ title, empty, rows, msg, error, bar, extraTabs = [], tab, setTab, children }: {
  title: string; empty: string; rows: Row[] | null; msg: string; error: string; bar?: ReactNode
  extraTabs?: [string, string][]; tab: string; setTab: (t: string) => void; children: ReactNode
}) {
  return (
    <div className="space-y-3 pb-24">
      <h2 className="text-xl font-bold text-ae-blue">{title}</h2>
      <Tabs tabs={[['todo', `To do${rows ? ` (${rows.length})` : ''}`], ...extraTabs, ['all', 'All orders']]} on={tab} set={setTab} />
      <OkBox>{msg}</OkBox>
      <ErrorBox>{error}</ErrorBox>
      {tab === 'all' ? <Orders embedded /> : tab !== 'todo' ? children
        : !rows ? <p className="text-sm text-stone-500">Loading…</p> : !rows.length ? <Card><p className="text-stone-600">{empty}</p></Card> : children}
      {tab === 'todo' && bar && rows && rows.length > 0 && <div className="fixed inset-x-0 bottom-0 z-10 border-t border-stone-200 bg-white/95 px-4 py-3 shadow-lg"><div className="mx-auto flex max-w-5xl justify-end">{bar}</div></div>}
    </div>
  )
}

const Tick = ({ on, disabled, set }: { on: boolean; disabled?: boolean; set: (v: boolean) => void }) => (
  <input type="checkbox" className="mt-1 h-6 w-6 shrink-0 accent-ae-blue" checked={on} disabled={disabled} onChange={(e) => set(e.target.checked)} />
)

// ---------- Plan: tick orders to send out, then send them to accounts ----------
export function PlanPage() {
  const { me } = useAuth()
  const { rows, load } = useStageRows('new')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [tab, setTab] = useState('todo')
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const allowed = can.plan(me?.role)
  const ready = (rows ?? []).filter((r) => !r.missing.length)

  const send = async () => {
    setBusy(true); setError(''); setMsg('')
    const ids = [...picked]
    const { data, error: e } = await supabase.rpc('plan_orders', { p_ids: ids })
    setBusy(false)
    if (e) { setError(e.message); return }
    setMsg(`${data} sent to accounts.`)
    setPicked(new Set())
    notify('planned', ids)
    load()
  }

  return (
    <Shell title="Plan" empty="Nothing to plan." rows={rows} msg={msg} error={error} tab={tab} setTab={setTab}
      bar={allowed && <Button disabled={!picked.size || busy} onClick={send}>{busy ? 'Sending…' : `Send to accounts (${picked.size})`}</Button>}>
      {allowed && ready.length > 1 && (
        <button type="button" className="text-sm font-semibold text-ae-blue underline" onClick={() => setPicked(picked.size === ready.length ? new Set() : new Set(ready.map((r) => r.id)))}>
          {picked.size === ready.length ? 'Untick all' : `Tick all ready (${ready.length})`}
        </button>
      )}
      <ul className="space-y-2">
        {rows?.map((o) => (
          <li key={o.id}>
            <Card className={`flex gap-3 p-3 sm:p-3 ${picked.has(o.id) ? 'border-ae-blue ring-2 ring-ae-blue/20' : ''}`}>
              {allowed && <Tick on={picked.has(o.id)} disabled={o.missing.length > 0} set={(v) => { const s = new Set(picked); if (v) s.add(o.id); else s.delete(o.id); setPicked(s) }} />}
              <div className="min-w-0 flex-1 space-y-1">
                <Head o={o} />
                <div className="text-sm text-stone-700">{itemsShort(o.order_lines)}</div>
                {o.missing.length > 0 && <div className="text-sm"><Badge tone="amber">Missing</Badge> {o.missing.join(', ')} · <Link to={`/orders/${o.id}`} className="font-semibold text-ae-blue underline">Fix</Link></div>}
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </Shell>
  )
}

// ---------- Invoice: accounts enters the Tally invoice for each planned order ----------
interface Inv { invoice_no: string; invoice_date: string; invoice_value: string; file?: File }

export function InvoiceFields({ v, set }: { v: Inv; set: (v: Inv) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Input className="col-span-2 sm:col-span-1" placeholder="Invoice no." value={v.invoice_no} onChange={(e) => set({ ...v, invoice_no: e.target.value })} aria-label="Invoice no." />
      <Input type="date" value={v.invoice_date} onChange={(e) => set({ ...v, invoice_date: e.target.value })} aria-label="Invoice date" />
      <Input inputMode="decimal" placeholder="Value ₹" value={v.invoice_value} onChange={(e) => set({ ...v, invoice_value: e.target.value.replace(/[^\d.]/g, '') })} aria-label="Invoice value" />
      <label className="flex min-h-12 cursor-pointer items-center justify-center truncate rounded-lg border border-dashed border-stone-300 bg-white px-2 text-sm font-semibold text-ae-blue">
        {v.file ? `📎 ${v.file.name}` : '📎 PDF'}
        <input type="file" accept="application/pdf,image/*" hidden onChange={(e) => set({ ...v, file: e.target.files?.[0] })} />
      </label>
    </div>
  )
}

export const invReady = (v?: Inv) => !!v && !!v.invoice_no.trim() && !!v.invoice_date && Number(v.invoice_value) > 0

export async function saveInvoices(entries: [string, Inv][]): Promise<number> {
  const { data, error } = await supabase.rpc('record_invoices', { p: entries.map(([id, v]) => ({ id, ...v, file: undefined })) })
  if (error) throw new Error(error.message)
  for (const [id, v] of entries) if (v.file) await attachFile(id, v.file, 'invoice')
  notify('invoiced', entries.map(([id]) => id))
  return data as number
}


export const blankInv = (o: { estimate_value: number }): Inv =>
  ({ invoice_no: '', invoice_date: todayIST(), invoice_value: o.estimate_value ? String(o.estimate_value) : '' })

export function InvoicePage() {
  const { me } = useAuth()
  const { rows, load } = useStageRows('planned')
  const [vals, setVals] = useState<Record<string, Inv>>({})
  const [tab, setTab] = useState('todo')
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const allowed = can.invoice(me?.role)
  useEffect(() => { if (rows) setVals((old) => Object.fromEntries(rows.map((o) => [o.id, old[o.id] ?? blankInv(o)]))) }, [rows])
  const filled = Object.entries(vals).filter(([, v]) => invReady(v))

  const save = async (entries: [string, Inv][]) => {
    setBusy(true); setError(''); setMsg('')
    try {
      const n = await saveInvoices(entries)
      setMsg(`${n} invoice${n === 1 ? '' : 's'} saved.`)
      load()
    } catch (e) { setError((e as Error).message) }
    setBusy(false)
  }

  return (
    <Shell title="Invoice" empty="Nothing to invoice." rows={rows} msg={msg} error={error} tab={tab} setTab={setTab}
      bar={allowed && <Button disabled={!filled.length || busy} onClick={() => save(filled)}>{busy ? 'Saving…' : `Save (${filled.length})`}</Button>}>
      <ul className="space-y-3">
        {rows?.map((o) => (
          <li key={o.id}>
            <Card className="space-y-2 p-3 sm:p-4">
              <Head o={o} />
              <div className="text-xs text-stone-500">{o.gstin ? `GSTIN ${o.gstin}` : 'No GSTIN'} · PO {o.po_number ?? '—'}</div>
              {Number(o.shipping_charge) > 0 && <div className="rounded-lg bg-ae-yellow px-3 py-1.5 text-sm font-semibold text-ae-blue">🚚 Add shipping {rupees(o.shipping_charge)}</div>}
              <ul className="rounded-lg bg-stone-50 px-3 py-2 text-sm">
                {o.order_lines.map((l, i) => (
                  <li key={i} className="flex justify-between gap-2"><span>{l.qty} × {l.tally_name ?? <span>{l.product_name} <span className="text-xs text-amber-700">(no Tally name)</span></span>}</span><span className="whitespace-nowrap text-stone-500">{rupees(l.rate)}</span></li>
                ))}
              </ul>
              {allowed && vals[o.id] && <InvoiceFields v={vals[o.id]} set={(v) => setVals({ ...vals, [o.id]: v })} />}
            </Card>
          </li>
        ))}
      </ul>
    </Shell>
  )
}

// ---------- Dispatch: tick what left today, with courier and docket ----------
interface Disp { on: boolean; courier: string; tracking_no: string; boxes: string; dispatch_note: string; file?: File }

export function DispatchFields({ v, set }: { v: Disp; set: (v: Disp) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      <Select value={v.courier} onChange={(e) => set({ ...v, courier: e.target.value })} aria-label="Courier">
        <option value="">Courier…</option>
        {COURIERS.map((c) => <option key={c}>{c}</option>)}
      </Select>
      <Input placeholder="Docket no." value={v.tracking_no} onChange={(e) => set({ ...v, tracking_no: e.target.value })} aria-label="Docket number" />
      <Input inputMode="numeric" placeholder="Boxes" value={v.boxes} onChange={(e) => set({ ...v, boxes: e.target.value.replace(/\D/g, '') })} aria-label="Boxes" />
      <Input placeholder="Note" value={v.dispatch_note} onChange={(e) => set({ ...v, dispatch_note: e.target.value })} aria-label="Note" />
      <label className="col-span-2 flex min-h-12 cursor-pointer items-center justify-center truncate rounded-lg border border-dashed border-stone-300 bg-white px-2 text-sm font-semibold text-ae-blue sm:col-span-1">
        {v.file ? `📷 ${v.file.name}` : '📷 Slip'}
        <input type="file" accept="image/*,application/pdf" hidden onChange={(e) => set({ ...v, file: e.target.files?.[0] })} />
      </label>
    </div>
  )
}

export const dispReady = (v?: Disp) => !!v && !!v.courier

const slip = async (f: File) => {
  const { compressImage } = await import('../lib/readers')
  return f.type.startsWith('image/') ? Object.assign(await compressImage(f), { name: f.name }) : f
}

export async function saveDispatches(date: string, entries: [string, Disp][]): Promise<number> {
  const { data, error } = await supabase.rpc('mark_dispatched', { p: entries.map(([id, v]) => ({ id, dispatch_date: date, courier: v.courier, tracking_no: v.tracking_no, boxes: v.boxes, dispatch_note: v.dispatch_note })) })
  if (error) throw new Error(error.message)
  for (const [id, v] of entries) if (v.file) await attachFile(id, await slip(v.file), 'tracking')
  notify('dispatched', entries.map(([id]) => id))
  return data as number
}

/** Add or fix tracking on an order that has already left. */
export async function saveTracking(id: string, v: Disp) {
  const { error } = await supabase.rpc('update_tracking', { p: { id, courier: v.courier, tracking_no: v.tracking_no, boxes: v.boxes, dispatch_note: v.dispatch_note } })
  if (error) throw new Error(error.message)
  if (v.file) await attachFile(id, await slip(v.file), 'tracking')
}

export const blankDisp = (o: { courier_pref: string | null }): Disp =>
  ({ on: false, courier: COURIERS.find((c) => c.toLowerCase() === (o.courier_pref ?? '').toLowerCase()) ?? 'DTDC', tracking_no: '', boxes: '', dispatch_note: '' })

/** The dispatch details already saved, ready to edit. */
export const savedDisp = (o: { shipping_charge: number; courier: string | null; tracking_no: string | null; boxes: number | null; dispatch_note: string | null }): Disp =>
  ({ on: true, courier: o.courier ?? '', tracking_no: o.tracking_no ?? '', boxes: o.boxes ? String(o.boxes) : '', dispatch_note: o.dispatch_note ?? '' })

export function DispatchPage() {
  const { me } = useAuth()
  const navigate = useNavigate()
  const { rows, load } = useStageRows('invoiced')
  const later = useStageRows('no_tracking')
  const [tab, setTab] = useState('todo')
  const [vals, setVals] = useState<Record<string, Disp>>({})
  const [track, setTrack] = useState<Record<string, Disp>>({})
  const [date, setDate] = useState(todayIST())
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const allowed = can.dispatch(me?.role)
  useEffect(() => { if (rows) setVals((old) => Object.fromEntries(rows.map((o) => [o.id, old[o.id] ?? blankDisp(o)]))) }, [rows])
  useEffect(() => { if (later.rows) setTrack((old) => Object.fromEntries(later.rows!.map((o) => [o.id, old[o.id] ?? savedDisp(o)]))) }, [later.rows])
  const picked = Object.entries(vals).filter(([, v]) => v.on)
  const ok = picked.length > 0 && picked.every(([, v]) => dispReady(v))

  const save = async () => {
    setBusy(true); setError(''); setMsg('')
    try {
      const n = await saveDispatches(date, picked)
      setMsg(`${n} dispatched.`)
      load(); later.load()
    } catch (e) { setError((e as Error).message) }
    setBusy(false)
  }
  const saveOne = async (id: string) => {
    setBusy(true); setError(''); setMsg('')
    try {
      await saveTracking(id, track[id])
      setMsg('Tracking saved.')
      setTrack(({ [id]: _, ...rest }) => rest)
      later.load()
    } catch (e) { setError((e as Error).message) }
    setBusy(false)
  }

  return (
    <Shell title="Dispatch" empty="Nothing to dispatch." rows={rows} msg={msg} error={error} tab={tab} setTab={setTab}
      extraTabs={[['later', `No tracking${later.rows ? ` (${later.rows.length})` : ''}`]]}
      bar={allowed && <Button disabled={!ok || busy} onClick={save}>{busy ? 'Saving…' : `Dispatched (${picked.length})`}</Button>}>
      {tab === 'later' ? (
        !later.rows ? <p className="text-sm text-stone-500">Loading…</p> : !later.rows.length ? <Card><p className="text-stone-600">All tracking added.</p></Card> : (
          <ul className="space-y-2">
            {later.rows.map((o) => (
              <li key={o.id}>
                <Card className="space-y-2 p-3 sm:p-3">
                  <Head o={o} />
                  <div className="text-xs text-stone-500">Sent {o.dispatch_date} · {o.courier} · Invoice {o.invoice_no}</div>
                  {allowed && track[o.id] && (
                    <>
                      <DispatchFields v={track[o.id]} set={(nv) => setTrack({ ...track, [o.id]: nv })} />
                      <Button disabled={busy || !track[o.id].tracking_no.trim()} onClick={() => saveOne(o.id)}>Save tracking</Button>
                    </>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )
      ) : (
        <>
          {allowed && <label className="flex items-center gap-2 text-sm font-semibold text-stone-700">Date <Input type="date" className="max-w-44" value={date} onChange={(e) => setDate(e.target.value)} /></label>}
          <ul className="space-y-2">
            {rows?.map((o) => {
              const v = vals[o.id]
              return (
                <li key={o.id}>
                  <Card className={`space-y-2 p-3 sm:p-3 ${v?.on ? 'border-ae-blue ring-2 ring-ae-blue/20' : ''}`}>
                    <div className="flex gap-3">
                      {allowed && v && <Tick on={v.on} set={(on) => setVals({ ...vals, [o.id]: { ...v, on } })} />}
                      <div className="min-w-0 flex-1 space-y-1">
                        <Head o={o} />
                        <div className="text-xs text-stone-500">Invoice {o.invoice_no}</div>
                        <button type="button" className="text-left text-sm text-stone-700" onClick={() => navigate(`/orders/${o.id}`)}>{itemsShort(o.order_lines)}</button>
                      </div>
                    </div>
                    {allowed && v?.on && <DispatchFields v={v} set={(nv) => setVals({ ...vals, [o.id]: nv })} />}
                  </Card>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </Shell>
  )
}
