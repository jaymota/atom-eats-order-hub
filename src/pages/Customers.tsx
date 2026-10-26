// Customer list. Anyone in the team can add or edit customers (orders need them).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Button, Card, ErrorBox, Field, Input, OkBox, Select } from '../components/ui'
import { fetchAll } from '../lib/catalog'
import { CHANNELS } from '../lib/channels'
import { GST_STATES, gstinState, nameSimilarity, norm } from '../lib/match'
import { supabase } from '../lib/supabase'

export { CHANNELS } from '../lib/channels'
const TERMS = ['advance', 'credit', 'COD', 'FOC']

export interface Customer {
  id: string
  code: string
  name: string
  default_channel: string | null
  gst_status: string | null
  gstin: string | null
  fssai: string | null
  contact_name: string | null
  phone: string | null
  email: string | null
  billing_address: string | null
  billing_city: string | null
  billing_state: string | null
  billing_pin: string | null
  payment_terms: string | null
  credit_days: number | null
  default_margin: number | null
  tally_name: string | null
  in_easy_ecom: boolean
  in_tally: boolean
  source: string | null
  notes: string | null
  active: boolean
  merged_into: string | null
}
interface Address {
  id: string
  label: string | null
  name: string | null
  address: string | null
  city: string | null
  state: string | null
  pin: string | null
  gstin: string | null
  contact_name: string | null
  phone: string | null
}

export const CUSTOMER_COLS = 'id, code, name, default_channel, gst_status, gstin, fssai, contact_name, phone, email, billing_address, billing_city, billing_state, billing_pin, payment_terms, credit_days, default_margin, tally_name, in_easy_ecom, in_tally, source, notes, active, merged_into'

/** Possible duplicates of a customer being added or edited. */
export function findSimilar(list: Customer[], c: Partial<Customer>): { c: Customer; why: string }[] {
  const out: { c: Customer; why: string }[] = []
  for (const x of list) {
    if (x.id === c.id || !x.active) continue
    if (c.gstin && x.gstin === c.gstin.toUpperCase()) out.push({ c: x, why: 'same GSTIN' })
    else if (c.phone && x.phone && x.phone.slice(-10) === c.phone.replace(/\D/g, '').slice(-10)) out.push({ c: x, why: 'same phone' })
    else if (c.name && nameSimilarity(c.name, x.name) >= 0.8) out.push({ c: x, why: 'very similar name' })
  }
  return out.slice(0, 5)
}

function CustomerForm({ c, all, onSaved, onCancel }: { c: Partial<Customer>; all: Customer[]; onSaved: (id: string) => void; onCancel: () => void }) {
  const [f, setF] = useState<Partial<Customer>>(c)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmDup, setConfirmDup] = useState(false)
  const set = (k: keyof Customer) => (e: { target: { value: string } }) => setF((v) => ({ ...v, [k]: e.target.value }))
  const similar = useMemo(() => findSimilar(all, f), [all, f])
  const state = gstinState(f.gstin)

  const save = async () => {
    if (!c.id && similar.length && !confirmDup) return setConfirmDup(true)
    setBusy(true)
    setError('')
    const fields = ['name', 'default_channel', 'gst_status', 'gstin', 'fssai', 'contact_name', 'phone', 'email', 'billing_address', 'billing_city', 'billing_state', 'billing_pin', 'payment_terms', 'credit_days', 'default_margin', 'tally_name', 'notes'] as const
    const p: Record<string, unknown> = {}
    for (const k of fields) p[k] = f[k] == null ? '' : String(f[k])
    if (state && !f.billing_state) p.billing_state = GST_STATES[state]
    if (state && !f.gst_status) p.gst_status = 'registered'
    const { data, error: e } = await supabase.rpc('save_customer', { p_id: c.id ?? null, p })
    setBusy(false)
    if (e) return setError(e.message)
    onSaved(data as string)
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Company / store name"><Input value={f.name ?? ''} onChange={set('name')} /></Field>
        <Field label="Usual channel">
          <Select value={f.default_channel ?? ''} onChange={set('default_channel')}>
            <option value="">—</option>
            {CHANNELS.map((ch) => <option key={ch}>{ch}</option>)}
          </Select>
        </Field>
        <Field label="GSTIN" hint={state ? `State: ${GST_STATES[state]}` : f.gstin ? 'Should be 15 characters, like 27AAACZ8867B1Z0' : undefined}>
          <Input value={f.gstin ?? ''} onChange={(e) => setF((v) => ({ ...v, gstin: e.target.value.toUpperCase().replace(/\s/g, '') }))} maxLength={15} />
        </Field>
        <Field label="GST status">
          <Select value={f.gst_status ?? ''} onChange={set('gst_status')}>
            <option value="">—</option><option value="registered">Registered</option><option value="unregistered">Unregistered</option>
          </Select>
        </Field>
        <Field label="Contact person"><Input value={f.contact_name ?? ''} onChange={set('contact_name')} /></Field>
        <Field label="Phone"><Input type="tel" value={f.phone ?? ''} onChange={set('phone')} /></Field>
        <Field label="Email"><Input type="email" value={f.email ?? ''} onChange={set('email')} /></Field>
        <Field label="FSSAI"><Input value={f.fssai ?? ''} onChange={set('fssai')} inputMode="numeric" /></Field>
        <div className="sm:col-span-2"><Field label="Billing address"><Input value={f.billing_address ?? ''} onChange={set('billing_address')} /></Field></div>
        <Field label="City"><Input value={f.billing_city ?? ''} onChange={set('billing_city')} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="State"><Input value={f.billing_state ?? ''} onChange={set('billing_state')} placeholder={state ? GST_STATES[state] : ''} /></Field>
          <Field label="PIN"><Input value={f.billing_pin ?? ''} onChange={set('billing_pin')} inputMode="numeric" maxLength={6} /></Field>
        </div>
        <Field label="Payment terms">
          <Select value={f.payment_terms ?? ''} onChange={set('payment_terms')}>
            <option value="">—</option>
            {TERMS.map((t) => <option key={t}>{t}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Credit days"><Input value={f.credit_days ?? ''} onChange={set('credit_days')} inputMode="numeric" /></Field>
          <Field label="Usual margin %"><Input value={f.default_margin ?? ''} onChange={set('default_margin')} inputMode="decimal" /></Field>
        </div>
        <Field label="Name in Tally"><Input value={f.tally_name ?? ''} onChange={set('tally_name')} /></Field>
        <Field label="Notes"><Input value={f.notes ?? ''} onChange={set('notes')} /></Field>
      </div>
      {similar.length > 0 && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <b>Is this already a customer?</b>
          <ul className="mt-1 list-disc pl-5">{similar.map((s) => <li key={s.c.id}>{s.c.name} ({s.c.code}) — {s.why}</li>)}</ul>
          {confirmDup && <p className="mt-1">Press Save again to add it anyway.</p>}
        </div>
      )}
      <ErrorBox>{error}</ErrorBox>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !f.name?.trim()} onClick={save}>{busy ? 'Saving…' : c.id ? 'Save changes' : confirmDup ? 'Save anyway' : 'Add customer'}</Button>
        <Button tone="plain" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

function AddressForm({ a, customerId, onDone }: { a: Partial<Address>; customerId: string; onDone: () => void }) {
  const [f, setF] = useState<Partial<Address>>(a)
  const [error, setError] = useState('')
  const set = (k: keyof Address) => (e: { target: { value: string } }) => setF((v) => ({ ...v, [k]: e.target.value }))
  const save = async () => {
    const { error: e } = await supabase.rpc('save_address', { p_id: a.id ?? null, p_customer: customerId, p: f })
    if (e) setError(e.message)
    else onDone()
  }
  return (
    <div className="grid gap-3 rounded-lg border border-stone-200 bg-ae-cream/40 p-3 sm:grid-cols-2">
      <Field label="Label (e.g. Bhiwandi warehouse)"><Input value={f.label ?? ''} onChange={set('label')} /></Field>
      <Field label="Name on parcel"><Input value={f.name ?? ''} onChange={set('name')} /></Field>
      <div className="sm:col-span-2"><Field label="Address"><Input value={f.address ?? ''} onChange={set('address')} /></Field></div>
      <Field label="City"><Input value={f.city ?? ''} onChange={set('city')} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="State"><Input value={f.state ?? ''} onChange={set('state')} /></Field>
        <Field label="PIN"><Input value={f.pin ?? ''} onChange={set('pin')} inputMode="numeric" maxLength={6} /></Field>
      </div>
      <Field label="GSTIN at this address (if different)"><Input value={f.gstin ?? ''} onChange={set('gstin')} maxLength={15} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Contact"><Input value={f.contact_name ?? ''} onChange={set('contact_name')} /></Field>
        <Field label="Phone"><Input value={f.phone ?? ''} onChange={set('phone')} type="tel" /></Field>
      </div>
      <div className="space-y-2 sm:col-span-2">
        <ErrorBox>{error}</ErrorBox>
        <div className="flex gap-2"><Button onClick={save}>Save address</Button><Button tone="plain" onClick={onDone}>Cancel</Button></div>
      </div>
    </div>
  )
}

function CustomerDetail({ c, all, onClose, onSaved }: { c: Customer; all: Customer[]; onClose: () => void; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [addresses, setAddresses] = useState<Address[]>([])
  const [aliases, setAliases] = useState<string[]>([])
  const [editAddr, setEditAddr] = useState<Partial<Address> | null>(null)
  const [msg, setMsg] = useState('')

  const loadAddr = useCallback(async () => {
    const [{ data: a }, { data: al }] = await Promise.all([
      supabase.from('customer_addresses').select('id, label, name, address, city, state, pin, gstin, contact_name, phone').eq('customer_id', c.id).order('created_at'),
      supabase.from('customer_aliases').select('alias').eq('customer_id', c.id),
    ])
    setAddresses((a ?? []) as Address[])
    setAliases((al ?? []).map((r) => r.alias))
  }, [c.id])
  useEffect(() => { loadAddr() }, [loadAddr])

  return (
    <Card className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-lg font-bold text-ae-blue">{c.name}</div>
          <div className="text-sm text-stone-600">{c.code}{c.default_channel && <> · {c.default_channel}</>}{c.billing_city && <> · {c.billing_city}</>}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {c.in_easy_ecom ? <Badge tone="green">In Easy Ecom</Badge> : <Badge tone="amber">Not in Easy Ecom yet</Badge>}
            {c.in_tally && <Badge>In Tally</Badge>}
            {!c.active && <Badge tone="red">{c.merged_into ? 'Merged into another customer' : 'Switched off'}</Badge>}
          </div>
        </div>
        <Button tone="plain" className="min-h-10 px-3 text-sm" onClick={onClose}>Close</Button>
      </div>
      <OkBox>{msg}</OkBox>
      {editing ? (
        <CustomerForm c={c} all={all} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); setMsg('Saved.'); onSaved() }} />
      ) : (
        <>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {([
              ['GSTIN', c.gstin ? `${c.gstin}${gstinState(c.gstin) ? ` (${GST_STATES[gstinState(c.gstin)!]})` : ''}` : c.gst_status === 'unregistered' ? 'Unregistered' : null],
              ['Contact', [c.contact_name, c.phone, c.email].filter(Boolean).join(' · ')],
              ['Billing address', [c.billing_address, c.billing_city, c.billing_state, c.billing_pin].filter(Boolean).join(', ')],
              ['FSSAI', c.fssai],
              ['Payment terms', [c.payment_terms, c.credit_days ? `${c.credit_days} days` : null].filter(Boolean).join(', ')],
              ['Usual margin', c.default_margin != null ? `${c.default_margin}%` : null],
              ['Name in Tally', c.tally_name],
              ['Came from', c.source],
              ['Notes', c.notes],
            ] as [string, string | null][]).map(([k, v]) => (
              <div key={k}><dt className="text-xs font-semibold text-stone-500">{k}</dt><dd className="text-stone-800">{v || <span className="text-amber-700">missing</span>}</dd></div>
            ))}
          </dl>
          {aliases.length > 0 && <p className="text-xs text-stone-500">Also known as: {aliases.join(', ')}</p>}
          <Button tone="plain" onClick={() => setEditing(true)}>Edit details</Button>
        </>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold text-stone-700">Delivery addresses ({addresses.length})</div>
          {!editAddr && <Button tone="plain" className="min-h-10 px-3 text-sm" onClick={() => setEditAddr({ name: c.name })}>+ Add address</Button>}
        </div>
        {editAddr && !editAddr.id && <AddressForm a={editAddr} customerId={c.id} onDone={() => { setEditAddr(null); loadAddr() }} />}
        <ul className="space-y-2">
          {addresses.map((a) => editAddr?.id === a.id ? (
            <li key={a.id}><AddressForm a={a} customerId={c.id} onDone={() => { setEditAddr(null); loadAddr() }} /></li>
          ) : (
            <li key={a.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-stone-200 px-3 py-2 text-sm">
              <div className="min-w-0">
                {a.label && <div className="font-semibold text-stone-800">{a.label}</div>}
                <div className="text-stone-700">{[a.name, a.address, a.city, a.state, a.pin].filter(Boolean).join(', ') || '—'}</div>
                {(a.gstin || a.phone) && <div className="text-xs text-stone-500">{[a.gstin && `GSTIN ${a.gstin}`, a.contact_name, a.phone].filter(Boolean).join(' · ')}</div>}
              </div>
              <div className="flex gap-2">
                <button type="button" className="text-sm font-semibold text-ae-blue underline" onClick={() => setEditAddr(a)}>Edit</button>
                <button type="button" className="text-sm font-semibold text-red-700 underline" onClick={async () => {
                  if (confirm('Remove this delivery address?')) { await supabase.rpc('delete_address', { p_id: a.id }); loadAddr() }
                }}>Remove</button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  )
}

export default function Customers() {
  const [all, setAll] = useState<Customer[]>([])
  const [aliasMap, setAliasMap] = useState<Map<string, string[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [channel, setChannel] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    const [cs, al] = await Promise.all([
      fetchAll<Customer>('customers', CUSTOMER_COLS, (x) => x.order('name')),
      fetchAll<{ customer_id: string; alias_norm: string }>('customer_aliases', 'customer_id, alias_norm'),
    ])
    const m = new Map<string, string[]>()
    for (const a of al) m.set(a.customer_id, [...(m.get(a.customer_id) ?? []), a.alias_norm])
    setAll(cs)
    setAliasMap(m)
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  const list = useMemo(() => {
    const qn = norm(q)
    const digits = q.replace(/\D/g, '')
    return all
      .filter((c) => c.active)
      .filter((c) => !channel || c.default_channel === channel)
      .filter((c) => !qn || norm(`${c.name} ${c.code} ${c.gstin ?? ''} ${c.billing_city ?? ''}`).includes(qn)
        || (digits.length >= 5 && (c.phone ?? '').includes(digits))
        || (aliasMap.get(c.id) ?? []).some((a) => a.includes(qn))
        || (qn.length >= 4 && nameSimilarity(q, c.name) >= 0.7))
  }, [all, aliasMap, q, channel])

  const openC = open ? all.find((c) => c.id === open) : null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-xl font-bold text-ae-blue">Customers</h2>
        {!adding && <Button onClick={() => { setAdding(true); setOpen(null) }}>+ Add customer</Button>}
      </div>
      {adding && (
        <Card>
          <h3 className="mb-3 font-semibold text-ae-blue">New customer</h3>
          <CustomerForm c={{}} all={all} onCancel={() => setAdding(false)} onSaved={async (id) => { setAdding(false); await load(); setOpen(id) }} />
        </Card>
      )}
      {openC && <CustomerDetail key={openC.id} c={openC} all={all} onClose={() => setOpen(null)} onSaved={load} />}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search: name, code, GSTIN, phone, city…" />
        <Select value={channel} onChange={(e) => setChannel(e.target.value)} className="sm:w-64">
          <option value="">All channels</option>
          {CHANNELS.map((ch) => <option key={ch}>{ch}</option>)}
        </Select>
      </div>
      {loading ? <p className="text-sm text-stone-500">Loading…</p> : (
        <Card className="p-0 sm:p-0">
          <div className="border-b border-stone-100 px-4 py-2 text-xs text-stone-500">{list.length} customers</div>
          <ul className="divide-y divide-stone-100">
            {list.slice(0, 200).map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => { setOpen(c.id); setAdding(false); window.scrollTo({ top: 0, behavior: 'smooth' }) }} className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left hover:bg-ae-cream/40">
                  <div className="min-w-0">
                    <div className="font-semibold text-stone-900">{c.name}</div>
                    <div className="text-xs text-stone-500">{c.code}{c.billing_city && ` · ${c.billing_city}`}{c.gstin && ` · ${c.gstin}`}</div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {c.default_channel && <Badge>{c.default_channel}</Badge>}
                    {!c.in_easy_ecom && <Badge tone="amber">Not in Easy Ecom</Badge>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {list.length > 200 && <p className="px-4 py-3 text-xs text-stone-500">Showing the first 200. Type to narrow it down.</p>}
        </Card>
      )}
    </div>
  )
}
