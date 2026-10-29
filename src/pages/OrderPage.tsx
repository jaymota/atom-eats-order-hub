// Everything about one order on one page: items, addresses, files, who did what, notes.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { Badge, Button, Card, ErrorBox, Input, OkBox } from '../components/ui'
import OrderReview from '../components/OrderReview'
import { useAuth } from '../lib/auth'
import { istDateTime } from '../lib/format'
import { BASIS_LABEL, loadDraft, type Draft, type PriceBasis } from '../lib/orders'
import { compressImage } from '../lib/readers'
import { age, can, isLate, notify, rupees, todayIST, attachFile, type Stage } from '../lib/stages'
import { supabase } from '../lib/supabase'
import { todoChanged } from '../lib/todo'
import { isBulkPack } from '../lib/match'
import { StageBadge } from './Orders'
import { DispatchFields, InvoiceFields, blankDisp, blankInv, dispReady, invReady, saveDispatches, saveInvoices, saveTracking, savedDisp } from './Todo'

interface Order {
  id: string; order_no: string; stage: Stage; channel: string; order_date: string; received_at: string; salesperson_id: string | null
  customer_id: string | null; customer_name: string; contact_name: string | null; phone: string | null; email: string | null
  gst_status: string | null; gstin: string | null; fssai: string | null; billing_address: string | null; billing_city: string | null
  billing_state: string | null; billing_pin: string | null; payment_terms: string | null; margin_pct: number | null; same_as_billing: boolean
  delivery_name: string | null; delivery_address: string | null; delivery_city: string | null; delivery_state: string | null; delivery_pin: string | null
  delivery_gstin: string | null; delivery_contact: string | null; delivery_phone: string | null; po_number: string | null; po_date: string | null
  needed_by: string | null; payment_type: string | null; courier_pref: string | null; notes: string | null; source: string; source_text: string | null
  estimate_value: number; missing: string[]; invoice_no: string | null; invoice_date: string | null; invoice_value: number | null
  po_generated: boolean; shipping_charge: number; dispatch_date: string | null; courier: string | null; tracking_no: string | null; hold_reason: string | null; cancel_reason: string | null
  shared_with: string | null; planned_by: string | null; boxes: number | null; dispatch_note: string | null; delivered_at: string | null; split_from: string | null
}
interface Line { id: string; sku: string; qty: number; price_basis: PriceBasis | null; margin_pct: number | null; rate: number | null; value: number; product_name: string | null; mrp: number | null; tally_name: string | null; typed_as: string | null }
interface FileRow { id: string; path: string; kind: string; name: string | null; created_at: string }
interface Ev { id: number; at: string; summary: string }
interface Note { id: string; body: string; created_at: string; person: { name: string } | null }

const SOURCE: Record<string, string> = { paste: 'pasted WhatsApp message', screenshot: 'screenshot / photo', po_file: 'PO file', blank: 'typed in', email: 'email PO' }

export default function OrderPage() {
  const { id } = useParams()
  const { me } = useAuth()
  const navigate = useNavigate()
  const loc = useLocation() as { state?: { saved?: string; complete?: boolean } }
  const [o, setO] = useState<Order | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [files, setFiles] = useState<(FileRow & { url?: string })[]>([])
  const [events, setEvents] = useState<Ev[]>([])
  const [notes, setNotes] = useState<Note[]>([])
  const [people, setPeople] = useState<Map<string, string>>(new Map())
  const [note, setNote] = useState('')
  const [edit, setEdit] = useState<Draft | null>(null)
  const [showMsg, setShowMsg] = useState(false)
  const [savedMsg, setSavedMsg] = useState(loc.state?.saved ? `Order ${loc.state.saved} saved.` : '')
  const [error, setError] = useState('')
  const [notFound, setNotFound] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    if (!id) return
    const [ord, ls, fs, ev, ns, pp] = await Promise.all([
      supabase.from('orders').select('*').eq('id', id).single(),
      supabase.from('order_lines').select('id, sku, qty, price_basis, margin_pct, rate, value, product_name, mrp, tally_name, typed_as').eq('order_id', id).order('line_no'),
      supabase.from('order_files').select('id, path, kind, name, created_at').eq('order_id', id).order('created_at'),
      supabase.from('activity').select('id, at, summary').eq('entity_type', 'order').eq('entity_id', id).order('at'),
      supabase.from('order_notes').select('id, body, created_at, person:people(name)').eq('order_id', id).order('created_at'),
      supabase.from('people').select('id, name'),
    ])
    if (ord.error) { setNotFound(true); return }
    setO(ord.data as Order)
    todoChanged()
    setLines((ls.data ?? []) as Line[])
    const fr = (fs.data ?? []) as FileRow[]
    const signed = fr.length ? (await supabase.storage.from('order-files').createSignedUrls(fr.map((f) => f.path), 3600)).data ?? [] : []
    setFiles(fr.map((f, i) => ({ ...f, url: signed[i]?.signedUrl ?? undefined })))
    setEvents((ev.data ?? []) as Ev[])
    setNotes((ns.data ?? []) as unknown as Note[])
    setPeople(new Map((pp.data ?? []).map((p) => [p.id, p.name])))
  }, [id])
  useEffect(() => { load() }, [load])
  // Opened with "Complete" from To confirm: go straight to filling in the sales order.
  useEffect(() => {
    if (loc.state?.complete && id) loadDraft(id).then((d) => setEdit({ ...d, confirm: true }))
  }, [id, loc.state?.complete])

  if (notFound) return <ErrorBox>Order not found.</ErrorBox>
  if (!o) return <p className="text-sm text-stone-500">Loading…</p>

  if (edit) {
    return (
      <div className="space-y-3">
        <h2 className="text-xl font-bold text-ae-blue">{edit.confirm ? 'Complete' : 'Edit'} {o.order_no}</h2>
        <OrderReview draft={edit} setDraft={setEdit} onBack={() => setEdit(null)} onSaved={(no) => { setSavedMsg(edit.confirm ? `${no} confirmed. It is now in Plan.` : `Order ${no} saved.`); setEdit(null); load() }} />
      </div>
    )
  }

  const late = isLate(o.stage, o.received_at)
  const canEdit = me?.role !== 'accounts' && (['sales_order', 'new', 'on_hold'].includes(o.stage) || me?.role === 'super_admin' || me?.role === 'admin')
  const back = me?.role === 'sales' ? ['/orders/new', '← New order'] : me?.role === 'accounts' ? ['/invoices', '← All invoices'] : ['/orders', '← All orders']
  const canHold = ['super_admin', 'admin', 'ops'].includes(me?.role ?? '')
  const deliverTo = o.same_as_billing
    ? [o.customer_name, o.billing_address, o.billing_city, o.billing_state, o.billing_pin]
    : [o.delivery_name, o.delivery_address, o.delivery_city, o.delivery_state, o.delivery_pin]

  const hold = async (action: 'hold' | 'cancel' | 'resume') => {
    const reason = action === 'resume' ? '' : prompt(action === 'hold' ? 'Why is this order on hold?' : 'Why is this order cancelled?') ?? ''
    if (action !== 'resume' && !reason.trim()) return
    const { error: e } = await supabase.rpc('set_order_hold', { p_order: o.id, p_action: action, p_reason: reason })
    if (e) setError(e.message)
    load()
  }

  const addFiles = async (fl: File[]) => {
    for (const f of fl) {
      const blob = await compressImage(f)
      const path = `${o.id}/${Date.now()}-${f.name.replace(/[^\w.-]+/g, '-').slice(0, 50)}`
      const up = await supabase.storage.from('order-files').upload(path, blob, { contentType: blob.type || f.type })
      if (up.error) { setError(up.error.message); return }
      await supabase.rpc('add_order_file', { p_order: o.id, p_path: path, p_kind: f.type.startsWith('image/') ? 'screenshot' : 'other', p_name: f.name, p_size: blob.size })
    }
    load()
  }

  const field = (k: string, v: string | null | undefined) => (
    <div key={k}><dt className="text-xs font-semibold text-stone-500">{k}</dt><dd className="text-stone-800">{v || <span className="text-amber-700">missing</span>}</dd></div>
  )

  return (
    <div className="space-y-4">
      <OkBox>{savedMsg}</OkBox>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to={back[0]} className="text-sm text-stone-500 underline">{back[1]}</Link>
          <h2 className="text-2xl font-bold text-ae-blue">{o.order_no} · {o.customer_name}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-stone-600">
            <StageBadge stage={o.stage} />
            <span>{o.channel}</span>
            <span className={late ? 'font-semibold text-red-700' : ''}>{late ? 'LATE · ' : ''}{age(o.received_at)} since it arrived</span>
            {o.salesperson_id && <span>· by {people.get(o.salesperson_id)}</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEdit && <Button tone="plain" onClick={async () => setEdit(await loadDraft(o.id))}>Edit</Button>}
          {canHold && !['cancelled', 'dispatched', 'delivered'].includes(o.stage) && (o.stage === 'on_hold'
            ? <Button tone="plain" onClick={() => hold('resume')}>Take off hold</Button>
            : <Button tone="plain" onClick={() => hold('hold')}>Put on hold</Button>)}
          {canHold && !['cancelled', 'dispatched', 'delivered'].includes(o.stage) && <Button tone="danger" onClick={() => hold('cancel')}>Cancel order</Button>}
        </div>
      </div>

      {o.stage === 'sales_order' && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ae-pink bg-ae-pink/40 px-3 py-3 text-sm text-ae-blue">
          <span><b>Sales order</b>{o.salesperson_id && <> from {people.get(o.salesperson_id)}</>}. Add the details, then confirm.</span>
          {canHold && <Button className="min-h-10 px-4 text-sm" onClick={async () => setEdit({ ...(await loadDraft(o.id)), confirm: true })}>Complete</Button>}
        </div>
      )}
      {o.missing.length > 0 && o.stage !== 'sales_order' && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <b>Missing information</b> (needed before dispatch planning): {o.missing.join(', ')}. {canEdit && <button type="button" className="font-semibold underline" onClick={async () => setEdit(await loadDraft(o.id))}>Fill it in</button>}
        </div>
      )}
      {o.stage === 'on_hold' && o.hold_reason && <p className="rounded-lg bg-stone-100 px-3 py-2 text-sm">On hold: {o.hold_reason}</p>}
      {o.stage === 'cancelled' && o.cancel_reason && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">Cancelled: {o.cancel_reason}</p>}
      <ErrorBox>{error}</ErrorBox>
      <NextStep key={o.stage} o={o} lines={lines} role={me?.role} onDone={(m) => { setSavedMsg(m); setError(''); load() }} onError={setError} />

      {o.invoice_no && (
        <Card>
          <h3 className="mb-2 font-semibold text-ae-blue">Invoice and dispatch</h3>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            {field('Invoice', `${o.invoice_no} · ${o.invoice_date ?? ''} · ${rupees(o.invoice_value)}`)}
            {o.dispatch_date && field('Dispatched', [o.dispatch_date, o.courier, o.tracking_no ?? (o.courier === 'Customer pickup' ? null : 'tracking to follow'), o.boxes ? `${o.boxes} box${o.boxes === 1 ? '' : 'es'}` : null].filter(Boolean).join(' · '))}
            {o.dispatch_note && field('Dispatch note', o.dispatch_note)}
            {o.delivered_at && field('Delivered', istDateTime(o.delivered_at))}
          </dl>
        </Card>
      )}

      <Card>
        <h3 className="mb-2 font-semibold text-ae-blue">Products</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-stone-500"><tr><th className="py-1 pr-2">Product</th><th className="px-2">Qty</th><th className="px-2">Price</th><th className="px-2 text-right">Value</th></tr></thead>
            <tbody className="divide-y divide-stone-100">
              {lines.map((l) => (
                <tr key={l.id}>
                  <td className="py-2 pr-2">
                    <div className="font-semibold text-stone-900">{l.product_name}</div>
                    <div className="text-xs text-stone-500"><span className="font-mono">{l.sku}</span>{l.tally_name && <> · Tally: {l.tally_name}</>}{l.typed_as && <> · said “{l.typed_as}”</>}</div>
                  </td>
                  <td className="px-2">{l.qty}</td>
                  <td className="px-2 text-xs">{l.rate != null ? rupees(l.rate) : '—'}<div className="text-stone-500">{l.price_basis ? BASIS_LABEL[l.price_basis] : 'no price yet'}{l.price_basis === 'mrp_minus_margin' && l.margin_pct != null && ` ${l.margin_pct}%`}{!isBulkPack(l.product_name) && <> · MRP {rupees(l.mrp)}</>}</div></td>
                  <td className="px-2 text-right font-semibold">{rupees(l.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2 text-right text-sm">
          {Number(o.shipping_charge) > 0 && <div className="font-semibold text-ae-blue">🚚 Shipping {rupees(o.shipping_charge)} (add to invoice)</div>}
          {o.invoice_value != null ? <>Invoice value: <b>{rupees(o.invoice_value)}</b></> : <>Estimated value (incl. GST): <b>{rupees(o.estimate_value)}</b></>}
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <h3 className="mb-2 font-semibold text-ae-blue">Customer {o.customer_id && <Link to="/customers" className="text-xs font-normal underline">(customer list)</Link>}</h3>
          <dl className="grid gap-2 text-sm">
            {field('Contact', [o.contact_name, o.phone, o.email].filter(Boolean).join(' · '))}
            {field('GST', o.gst_status === 'unregistered' ? 'Unregistered' : o.gstin)}
            {field('Billing address', [o.billing_address, o.billing_city, o.billing_state, o.billing_pin].filter(Boolean).join(', '))}
            {field('Payment terms', o.payment_terms)}
          </dl>
        </Card>
        <Card>
          <h3 className="mb-2 font-semibold text-ae-blue">Delivery and payment</h3>
          <dl className="grid gap-2 text-sm">
            {field('Deliver to', deliverTo.filter(Boolean).join(', '))}
            {(o.delivery_contact || o.delivery_phone) && field('Delivery contact', [o.delivery_contact, o.delivery_phone].filter(Boolean).join(' · '))}
            {field('PO', o.po_number ? `${o.po_number}${o.po_date ? ` (${o.po_date})` : ''}${o.po_generated ? ' · made by the Hub (no PO from the party)' : ''}` : null)}
            {field('Payment type', o.payment_type)}
            {o.needed_by && field('Needed by', o.needed_by)}
            {o.courier_pref && field('Preferred courier', o.courier_pref)}
            {o.notes && field('Notes', o.notes)}
          </dl>
        </Card>
      </div>

      <Card>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold text-ae-blue">Files</h3>
          <Button tone="plain" className="min-h-10 px-3 text-sm" onClick={() => fileRef.current?.click()}>+ Add file</Button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) addFiles(f) }} />
        </div>
        <p className="mb-2 text-sm text-stone-600">Entered from a {SOURCE[o.source] ?? o.source}.{o.source_text && <> <button type="button" className="font-semibold text-ae-blue underline" onClick={() => setShowMsg(!showMsg)}>{showMsg ? 'Hide' : 'Show'} the original message</button></>}</p>
        {showMsg && o.source_text && <pre className="mb-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-xs text-stone-700">{o.source_text}</pre>}
        {files.length ? (
          <ul className="flex flex-wrap gap-3">
            {files.map((f) => (
              <li key={f.id} className="text-sm">
                <a href={f.url} target="_blank" rel="noreferrer" className="block">
                  {/\.(jpe?g|png|webp)$/i.test(f.path) && f.url ? <img src={f.url} alt={f.name ?? ''} className="h-28 w-28 rounded-lg border object-cover" /> : <span className="inline-block rounded-lg border px-3 py-2 text-ae-blue underline">{f.name ?? 'file'}</span>}
                </a>
                <Badge>{f.kind}</Badge>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-stone-500">No files.</p>}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <h3 className="mb-2 font-semibold text-ae-blue">Timeline</h3>
          <ul className="space-y-2 text-sm">
            {events.map((e) => <li key={e.id}><div className="text-stone-800">{e.summary}</div><div className="text-xs text-stone-500">{istDateTime(e.at)}</div></li>)}
          </ul>
        </Card>
        <Card>
          <h3 className="mb-2 font-semibold text-ae-blue">Notes from the team</h3>
          <ul className="mb-3 space-y-2 text-sm">
            {notes.map((n) => <li key={n.id}><div className="text-stone-800">{n.body}</div><div className="text-xs text-stone-500">{n.person?.name} · {istDateTime(n.created_at)}</div></li>)}
            {!notes.length && <li className="text-stone-500">No notes yet.</li>}
          </ul>
          <div className="flex gap-2">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…" />
            <Button disabled={!note.trim()} onClick={async () => {
              const { error: e } = await supabase.rpc('add_order_note', { p_order: o.id, p_body: note })
              if (e) setError(e.message)
              else { setNote(''); load() }
            }}>Add</Button>
          </div>
        </Card>
      </div>
      {me?.role !== 'accounts' && <div className="pb-6"><button type="button" className="text-sm text-stone-500 underline" onClick={() => navigate('/orders/new')}>Enter another order</button></div>}
    </div>
  )
}

// ---------- The next step for this order, depending on its stage and who is looking ----------
function NextStep({ o, lines, role, onDone, onError }: { o: Order; lines: Line[]; role?: string; onDone: (msg: string) => void; onError: (e: string) => void }) {
  const [inv, setInv] = useState(() => blankInv(o))
  const [disp, setDisp] = useState(() => ({ ...blankDisp(o), on: true }))
  const [date, setDate] = useState(todayIST())
  const [split, setSplit] = useState<Record<string, number> | null>(null)
  const [trk, setTrk] = useState<ReturnType<typeof savedDisp> | null>(null)
  const [busy, setBusy] = useState(false)
  const proofRef = useRef<HTMLInputElement>(null)

  const run = async (fn: () => Promise<string>) => {
    setBusy(true)
    try { onDone(await fn()) } catch (e) { onError((e as Error).message) }
    setBusy(false)
  }
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await supabase.rpc(name, args)
    if (error) throw new Error(error.message)
    return data
  }
  const undo = () => run(async () => { await rpc('undo_stage', { p_order: o.id }); return 'Moved back one step.' })
  const canSplit = can.plan(role) && ['new', 'planned', 'on_hold'].includes(o.stage) && lines.some((l) => l.qty > 1 || lines.length > 1)

  let body: ReactNode = null
  if (o.stage === 'new' && can.plan(role)) {
    body = <Button disabled={busy || o.missing.length > 0} onClick={() => run(async () => { await rpc('plan_orders', { p_ids: [o.id] }); notify('planned', [o.id]); return 'Sent to accounts.' })}>Plan → accounts</Button>
  } else if (o.stage === 'planned' && can.invoice(role)) {
    body = (
      <div className="space-y-2">
        <InvoiceFields v={inv} set={setInv} />
        <Button disabled={busy || !invReady(inv)} onClick={() => run(async () => { await saveInvoices([[o.id, inv]]); return 'Invoice saved.' })}>Save invoice</Button>
      </div>
    )
  } else if (o.stage === 'invoiced' && can.dispatch(role)) {
    body = (
      <div className="space-y-2">
        <Input type="date" className="max-w-44" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Dispatch date" />
        <DispatchFields v={disp} set={setDisp} />
        <Button disabled={busy || !dispReady(disp)} onClick={() => run(async () => { await saveDispatches(date, [[o.id, disp]]); return 'Dispatched.' })}>Dispatched</Button>
      </div>
    )
  } else if (['dispatched', 'delivered'].includes(o.stage) && can.dispatch(role)) {
    body = trk ? (
      <div className="space-y-2">
        <DispatchFields v={trk} set={setTrk} />
        <div className="flex gap-2">
          <Button disabled={busy || !dispReady(trk)} onClick={() => run(async () => { await saveTracking(o.id, trk); setTrk(null); return 'Tracking saved.' })}>Save tracking</Button>
          <Button tone="plain" onClick={() => setTrk(null)}>Back</Button>
        </div>
      </div>
    ) : (
      <div className="flex flex-wrap gap-2">
        {o.stage === 'dispatched' && <Button disabled={busy} onClick={() => run(async () => { await rpc('mark_delivered', { p_ids: [o.id] }); return 'Delivered.' })}>Delivered</Button>}
        <Button tone={o.tracking_no ? 'plain' : 'primary'} disabled={busy} onClick={() => setTrk(savedDisp(o))}>{o.tracking_no ? '✏️ Tracking' : '+ Tracking'}</Button>
        <Button tone="plain" disabled={busy} onClick={() => proofRef.current?.click()}>📎 Proof / GRN</Button>
        <input ref={proofRef} type="file" accept="image/*,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) run(async () => { await attachFile(o.id, f, 'grn'); return 'File added.' }) }} />
      </div>
    )
  }
  const mayUndo = (o.stage === 'planned' && can.plan(role)) || (o.stage === 'invoiced' && can.invoice(role)) || (o.stage === 'dispatched' && (role === 'admin' || role === 'super_admin'))
  if (!body && !mayUndo && !canSplit) return null

  return (
    <Card className="border-ae-blue/30 bg-ae-cream/40">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="font-semibold text-ae-blue">Next step</h3>
        <div className="flex gap-3 text-sm">
          {canSplit && <button type="button" className="font-semibold text-ae-blue underline" onClick={() => setSplit(split ? null : Object.fromEntries(lines.map((l) => [l.id, l.qty])))}>Split</button>}
          {mayUndo && <button type="button" className="text-stone-500 underline" disabled={busy} onClick={undo}>Undo last step</button>}
        </div>
      </div>
      {split ? (
        <div className="space-y-2">
          <p className="text-sm text-stone-600">Qty going now. The rest becomes a new order.</p>
          {lines.map((l) => (
            <div key={l.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 flex-1">{l.product_name} <span className="text-stone-400">of {l.qty}</span></span>
              <Input inputMode="numeric" className="max-w-20" onFocus={(e) => e.target.select()} value={String(split[l.id])} onChange={(e) => setSplit({ ...split, [l.id]: Math.min(l.qty, Number(e.target.value.replace(/\D/g, '')) || 0) })} />
            </div>
          ))}
          <div className="flex gap-2">
            <Button disabled={busy} onClick={() => run(async () => {
              const id = await rpc('split_order', { p_order: o.id, p_send: Object.entries(split).map(([line_id, qty]) => ({ line_id, qty })) })
              setSplit(null)
              const { data } = await supabase.from('orders').select('order_no').eq('id', id).single()
              return `Split. The rest is ${data?.order_no}.`
            })}>Split</Button>
            <Button tone="plain" onClick={() => setSplit(null)}>Back</Button>
          </div>
        </div>
      ) : body}
    </Card>
  )
}
