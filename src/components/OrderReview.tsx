// The whole order on one screen: check it, fill in anything missing, save.
// Used at the end of the order form and for editing a saved order.
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { productLabel, useCatalog } from '../lib/catalog'
import { GST_STATES, gstinState } from '../lib/match'
import {
  BASIS_LABEL, COURIERS, PAYMENT_TYPES, PO_CHANNELS, draftTotal, findRepeat, lineRate, mustHave, newKey, saveDraft, stateFromGstin, stillMissing,
  type Draft, type DraftLine, type PriceBasis,
} from '../lib/orders'
import { rupees } from '../lib/stages'
import { supabase } from '../lib/supabase'
import { CHANNELS } from '../pages/Customers'
import { ProductPicker } from '../pages/Checks'
import { Button, Card, ErrorBox, Field, Input, Select } from './ui'

const TERMS = ['advance', 'credit', 'COD', 'FOC']

export default function OrderReview({ draft, setDraft, onBack, onSaved }: { draft: Draft; setDraft: (d: Draft) => void; onBack?: () => void; onSaved?: (orderNo: string) => void }) {
  const { catalog } = useCatalog()
  const navigate = useNavigate()
  const [people, setPeople] = useState<{ id: string; name: string }[]>([])
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [warn, setWarn] = useState('')

  useEffect(() => {
    supabase.from('people').select('id, name').eq('active', true).order('name').then(({ data }) => setPeople(data ?? []))
  }, [])

  const d = draft
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...d, [k]: v })
  const inp = (k: keyof Draft) => ({ value: String(d[k] ?? ''), onChange: (e: { target: { value: string } }) => set(k, e.target.value as never) })
  const setLine = (key: string, patch: Partial<DraftLine>) => setDraft({ ...d, lines: d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) })

  const must = mustHave(d)
  const missing = stillMissing(d)
  const total = catalog ? draftTotal(d, catalog) : 0
  const gstState = gstinState(d.gstin)
  const po = PO_CHANNELS.includes(d.channel)

  /** One margin for every line priced as "MRP minus margin". */
  const applyMargin = (m: number | null) => setDraft({
    ...d, margin_pct: m,
    lines: d.lines.map((l) => (l.price_basis === 'mrp_minus_margin' || !l.price_basis ? { ...l, price_basis: 'mrp_minus_margin', margin_pct: m } : l)),
  })

  const save = async (anyway: boolean) => {
    if (must.length) return
    if (missing.length && !anyway) return
    setBusy(true)
    setError('')
    try {
      if (!warn) {
        const repeat = await findRepeat(d)
        if (repeat) {
          setWarn(`This customer already has order ${repeat} with very similar products in the last 3 days. Is this a new order? Press save again to save it anyway.`)
          setBusy(false)
          return
        }
      }
      const r = await saveDraft(d)
      if (onSaved) onSaved(r.orderNo)
      else navigate(`/orders/${r.id}`, { state: { saved: r.orderNo } })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const sectionTitle = (t: string) => <h3 className="mb-3 font-semibold text-ae-blue">{t}</h3>

  const lineRows = useMemo(() => d.lines.map((l) => {
    const p = catalog?.bySku.get(l.sku)
    return { l, p, rate: lineRate(l, p?.mrp ?? null) }
  }), [d.lines, catalog])

  return (
    <div className="space-y-4 pb-28">
      <Card>
        {sectionTitle('Order')}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Channel ✱">
            <Select {...inp('channel')}>
              <option value="">Choose…</option>
              {CHANNELS.map((c) => <option key={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="Order date ✱"><Input type="date" {...inp('order_date')} /></Field>
          <Field label="Salesperson ✱">
            <Select value={d.salesperson_id ?? ''} onChange={(e) => set('salesperson_id', e.target.value || null)}>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label={`PO number${po ? ' ✱✱' : ''}`}><Input {...inp('po_number')} /></Field>
          <Field label={`PO date${po ? ' ✱✱' : ''}`}><Input type="date" {...inp('po_date')} /></Field>
          <Field label="Needed by"><Input type="date" {...inp('needed_by')} /></Field>
        </div>
      </Card>

      <Card>
        {sectionTitle(d.customer_id ? 'Customer' : 'Customer (new — will be saved)')}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Company / store name ✱"><Input {...inp('customer_name')} /></Field>
          <Field label="Phone ✱"><Input type="tel" {...inp('phone')} /></Field>
          <Field label="Contact person"><Input {...inp('contact_name')} /></Field>
          <Field label="Email"><Input type="email" {...inp('email')} /></Field>
          <Field label="GST status ✱✱">
            <Select {...inp('gst_status')}>
              <option value="">Choose…</option><option value="registered">Registered</option><option value="unregistered">Unregistered</option>
            </Select>
          </Field>
          <Field label="GSTIN ✱✱" hint={gstState ? `State: ${GST_STATES[gstState]}` : d.gstin ? 'Should be 15 characters, like 27AAACZ8867B1Z0' : undefined}>
            <Input value={d.gstin} maxLength={15} onChange={(e) => {
              const g = e.target.value.toUpperCase().replace(/\s/g, '')
              setDraft({ ...d, gstin: g, gst_status: gstinState(g) ? 'registered' : d.gst_status, billing_state: d.billing_state || stateFromGstin(g) })
            }} />
          </Field>
          <div className="sm:col-span-2"><Field label="Billing address ✱✱"><Input {...inp('billing_address')} /></Field></div>
          <Field label="City"><Input {...inp('billing_city')} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="State ✱✱"><Input {...inp('billing_state')} /></Field>
            <Field label="PIN ✱✱"><Input {...inp('billing_pin')} inputMode="numeric" maxLength={6} /></Field>
          </div>
          <Field label="Payment terms ✱✱">
            <Select {...inp('payment_terms')}><option value="">Choose…</option>{TERMS.map((t) => <option key={t}>{t}</option>)}</Select>
          </Field>
          <Field label="FSSAI"><Input {...inp('fssai')} inputMode="numeric" /></Field>
        </div>
      </Card>

      <Card>
        {sectionTitle('Delivery')}
        <label className="mb-3 flex items-center gap-2 text-sm font-semibold text-stone-700">
          <input type="checkbox" className="h-5 w-5" checked={d.same_as_billing} onChange={(e) => set('same_as_billing', e.target.checked)} />
          Same as billing address
        </label>
        {!d.same_as_billing && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name on parcel"><Input {...inp('delivery_name')} /></Field>
            <Field label="Delivery GSTIN (if different)"><Input {...inp('delivery_gstin')} maxLength={15} /></Field>
            <div className="sm:col-span-2"><Field label="Delivery address ✱✱"><Input value={d.delivery_address} onChange={(e) => setDraft({ ...d, delivery_address: e.target.value, address_id: null })} /></Field></div>
            <Field label="City"><Input {...inp('delivery_city')} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="State ✱✱"><Input {...inp('delivery_state')} /></Field>
              <Field label="PIN ✱✱"><Input {...inp('delivery_pin')} inputMode="numeric" maxLength={6} /></Field>
            </div>
            <Field label="Delivery contact"><Input {...inp('delivery_contact')} /></Field>
            <Field label="Delivery phone"><Input type="tel" {...inp('delivery_phone')} /></Field>
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <h3 className="font-semibold text-ae-blue">Products</h3>
          <div className="flex items-end gap-2">
            <Field label="Margin % for all">
              <Input className="w-24" inputMode="decimal" value={d.margin_pct ?? ''} onChange={(e) => applyMargin(e.target.value === '' ? null : Number(e.target.value))} />
            </Field>
          </div>
        </div>
        <ul className="divide-y divide-stone-100">
          {lineRows.map(({ l, p, rate }) => (
            <li key={l.key} className="space-y-2 py-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 text-sm">
                  <div className="font-semibold text-stone-900">{p ? productLabel(p) : l.sku}</div>
                  <div className="text-xs text-stone-500"><span className="font-mono">{l.sku}</span>{p?.tally_name && <> · Tally: {p.tally_name}</>}{l.typed_as && <> · message said “{l.typed_as}”</>}</div>
                </div>
                <button type="button" className="text-sm font-semibold text-red-700 underline" onClick={() => setDraft({ ...d, lines: d.lines.filter((x) => x.key !== l.key) })}>Remove</button>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Field label="Quantity ✱"><Input inputMode="numeric" value={l.qty ?? ''} onChange={(e) => setLine(l.key, { qty: e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value))) })} /></Field>
                <Field label="Price basis ✱✱">
                  <Select value={l.price_basis ?? ''} onChange={(e) => setLine(l.key, { price_basis: (e.target.value || null) as PriceBasis | null, margin_pct: e.target.value === 'mrp_minus_margin' ? l.margin_pct ?? d.margin_pct : l.margin_pct })}>
                    <option value="">Choose…</option>
                    {(Object.keys(BASIS_LABEL) as PriceBasis[]).map((b) => <option key={b} value={b}>{BASIS_LABEL[b]}</option>)}
                  </Select>
                </Field>
                {l.price_basis === 'mrp_minus_margin' ? (
                  <Field label="Margin %"><Input inputMode="decimal" value={l.margin_pct ?? ''} onChange={(e) => setLine(l.key, { margin_pct: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
                ) : l.price_basis === 'foc' ? <div /> : (
                  <Field label="Rate per pack (incl. GST)"><Input inputMode="decimal" value={l.rate ?? ''} onChange={(e) => setLine(l.key, { rate: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
                )}
                <div className="text-sm">
                  <div className="text-xs font-semibold text-stone-500">Value</div>
                  <div className="mt-2 font-semibold text-stone-900">{rate == null ? '—' : rupees(rate * (l.qty ?? 0))}</div>
                  {rate != null && <div className="text-xs text-stone-500">{rupees(rate)} each · MRP {rupees(p?.mrp)}</div>}
                </div>
              </div>
            </li>
          ))}
        </ul>
        {adding ? (
          <div className="mt-3"><ProductPicker onPick={(p) => {
            setDraft({ ...d, lines: [...d.lines, { key: newKey(), sku: p.sku, qty: null, typed_as: null, price_basis: d.channel === 'FOC samples' ? 'foc' : 'mrp_minus_margin', margin_pct: d.margin_pct, rate: null, learn: false }] })
            setAdding(false)
          }} /></div>
        ) : (
          <Button tone="plain" className="mt-3" onClick={() => setAdding(true)}>+ Add a product</Button>
        )}
        <div className="mt-3 text-right text-sm text-stone-700">Estimated value (incl. GST): <b className="text-lg text-stone-900">{rupees(total)}</b></div>
      </Card>

      <Card>
        {sectionTitle('Payment and dispatch')}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Payment type ✱✱">
            <Select {...inp('payment_type')}><option value="">Choose…</option>{PAYMENT_TYPES.map((t) => <option key={t}>{t}</option>)}</Select>
          </Field>
          <Field label="Preferred courier">
            <Select {...inp('courier_pref')}><option value="">—</option>{COURIERS.map((t) => <option key={t}>{t}</option>)}</Select>
          </Field>
          <Field label="Notes"><Input {...inp('notes')} /></Field>
        </div>
      </Card>

      {/* Sticky save bar, easy to reach on a phone */}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-stone-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
        <div className="mx-auto max-w-5xl space-y-2">
          {must.length > 0 && <p className="text-sm text-red-700">Needed to save: {must.join(', ')}.</p>}
          {!must.length && missing.length > 0 && <p className="text-sm text-amber-800"><b>Still missing</b> (needed before dispatch planning): {missing.join(', ')}. You can fill them now or save anyway.</p>}
          {warn && <p className="text-sm text-amber-800">{warn}</p>}
          <ErrorBox>{error}</ErrorBox>
          <div className="flex flex-wrap gap-2">
            {onBack && <Button tone="plain" onClick={onBack}>Back</Button>}
            {missing.length === 0 ? (
              <Button disabled={busy || must.length > 0} onClick={() => save(false)} className="flex-1">{busy ? 'Saving…' : d.id ? 'Save changes' : 'Save order'}</Button>
            ) : (
              <Button disabled={busy || must.length > 0} onClick={() => save(true)} className="flex-1">{busy ? 'Saving…' : 'Save anyway (missing info)'}</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
