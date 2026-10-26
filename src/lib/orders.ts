// Order drafts, the "still missing" check, and saving an order with its customer, address,
// files and what the form learnt.
import { fetchAll, loadCatalog, type Catalog } from './catalog'
import { GST_STATES, gstinState, norm, tidy } from './match'
import { compressImage } from './readers'
import type { CustomerLite } from './resolve'
import { supabase } from './supabase'

export const PO_CHANNELS = ['Blinkit', 'Foodstories', 'Food Square', 'Other retail chains / corporates']
export const PAYMENT_TYPES = ['Prepaid', 'Credit', 'COD', 'Cheque', 'FOC'] as const
export const COURIERS = ['DTDC', 'Porter', 'Customer pickup', 'Other']

export type PriceBasis = 'mrp_minus_margin' | 'po_rate' | 'agreed_rate' | 'foc'
export const BASIS_LABEL: Record<PriceBasis, string> = {
  mrp_minus_margin: 'MRP minus margin', po_rate: 'PO rate', agreed_rate: 'Agreed rate', foc: 'Free (FOC)',
}

export interface DraftLine {
  key: string
  sku: string
  qty: number | null
  typed_as: string | null
  price_basis: PriceBasis | null
  margin_pct: number | null
  rate: number | null
  learn: boolean // the person picked this product for what the message said: remember it
  ean_seen?: string | null // barcode printed on the PO for this line (remembered once confirmed)
}

export interface Draft {
  id: string | null
  channel: string
  order_date: string
  salesperson_id: string | null
  customer_id: string | null
  customer_name: string
  contact_name: string
  phone: string
  email: string
  gst_status: string
  gstin: string
  fssai: string
  billing_address: string
  billing_city: string
  billing_state: string
  billing_pin: string
  payment_terms: string
  margin_pct: number | null
  same_as_billing: boolean
  address_id: string | null
  delivery_name: string
  delivery_address: string
  delivery_city: string
  delivery_state: string
  delivery_pin: string
  delivery_gstin: string
  delivery_contact: string
  delivery_phone: string
  po_number: string
  po_date: string
  needed_by: string
  payment_type: string
  courier_pref: string
  notes: string
  lines: DraftLine[]
  source: string
  source_text: string
  files: File[]
  learn_customer_alias: string | null
}

export const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
let lineSeq = 0
export const newKey = () => `l${Date.now()}-${++lineSeq}`

export function emptyDraft(salespersonId: string | null): Draft {
  return {
    id: null, channel: '', order_date: todayIST(), salesperson_id: salespersonId,
    customer_id: null, customer_name: '', contact_name: '', phone: '', email: '', gst_status: '', gstin: '', fssai: '',
    billing_address: '', billing_city: '', billing_state: '', billing_pin: '', payment_terms: '', margin_pct: null,
    same_as_billing: false, address_id: null, delivery_name: '', delivery_address: '', delivery_city: '', delivery_state: '',
    delivery_pin: '', delivery_gstin: '', delivery_contact: '', delivery_phone: '',
    po_number: '', po_date: '', needed_by: '', payment_type: '', courier_pref: '', notes: '',
    lines: [], source: 'blank', source_text: '', files: [], learn_customer_alias: null,
  }
}

/** Price for one line: MRP minus margin, a PO / agreed rate, or free. */
export function lineRate(l: DraftLine, mrp: number | null): number | null {
  if (l.price_basis === 'foc') return 0
  if (l.price_basis === 'mrp_minus_margin') return l.margin_pct != null && mrp != null ? Math.round(mrp * (1 - l.margin_pct / 100) * 100) / 100 : null
  return l.rate
}

export function draftTotal(d: Draft, c: Catalog): number {
  return d.lines.reduce((s, l) => s + (lineRate(l, c.bySku.get(l.sku)?.mrp ?? null) ?? 0) * (l.qty ?? 0), 0)
}

/** ✱ details: the order can't be saved without these. */
export function mustHave(d: Draft): string[] {
  const m: string[] = []
  if (!d.channel) m.push('channel')
  if (!d.customer_name.trim()) m.push('customer')
  if (!d.phone.trim()) m.push('phone number')
  if (!d.lines.length) m.push('at least one product')
  if (d.lines.some((l) => !l.qty || l.qty <= 0)) m.push('a quantity for every product')
  return m
}

/** ✱✱ details: needed before the order can be planned for dispatch (same rules as the database). */
export function stillMissing(d: Draft): string[] {
  const m: string[] = []
  const po = PO_CHANNELS.includes(d.channel)
  if (po && !d.po_number.trim()) m.push('PO number')
  if (po && !d.po_date) m.push('PO date')
  if (!d.gst_status) m.push('GST status')
  if (d.gst_status === 'registered' && !d.gstin.trim()) m.push('GSTIN')
  if (!d.billing_address.trim()) m.push('billing address')
  if (!d.billing_state.trim()) m.push('billing state')
  if (!d.billing_pin.trim()) m.push('billing PIN')
  if (!d.payment_terms) m.push('payment terms')
  const del = d.same_as_billing ? { a: d.billing_address, s: d.billing_state, p: d.billing_pin } : { a: d.delivery_address, s: d.delivery_state, p: d.delivery_pin }
  if (!del.a.trim()) m.push('delivery address')
  if (!del.s.trim()) m.push('delivery state')
  if (!del.p.trim()) m.push('delivery PIN')
  if (!d.payment_type) m.push('payment type')
  if (d.lines.some((l) => !l.price_basis || (l.price_basis === 'mrp_minus_margin' ? l.margin_pct == null : l.price_basis !== 'foc' && l.rate == null))) m.push('price for every product')
  return m
}

// ---------- addresses from message lines ----------

export { splitAddress } from './address'

export function stateFromGstin(g: string): string {
  const s = gstinState(g)
  return s ? GST_STATES[s] : ''
}

// ---------- customers, for matching ----------

let custCache: { list: CustomerLite[]; aliases: Map<string, string[]> } | null = null

export async function loadCustomersLite(force = false) {
  if (custCache && !force) return custCache
  const [list, al] = await Promise.all([
    fetchAll<CustomerLite>('customers', 'id, code, name, phone, gstin, billing_city, default_channel, default_margin, active'),
    fetchAll<{ customer_id: string; alias_norm: string }>('customer_aliases', 'customer_id, alias_norm'),
  ])
  const aliases = new Map<string, string[]>()
  for (const a of al) aliases.set(a.customer_id, [...(aliases.get(a.customer_id) ?? []), a.alias_norm])
  custCache = { list, aliases }
  return custCache
}

/** Copies a saved customer's details into the draft (keeps anything the message already gave). */
export async function applyCustomer(d: Draft, customerId: string): Promise<Draft> {
  const [{ data: c }, { data: addrs }] = await Promise.all([
    supabase.from('customers').select('*').eq('id', customerId).single(),
    supabase.from('customer_addresses').select('*').eq('customer_id', customerId).order('is_default', { ascending: false }).order('created_at'),
  ])
  if (!c) return d
  const pick = (mine: string, theirs: string | null | undefined) => mine || theirs || ''
  const next: Draft = {
    ...d,
    customer_id: c.id,
    customer_name: c.name,
    channel: d.channel || c.default_channel || '',
    contact_name: pick(d.contact_name, c.contact_name),
    phone: pick(d.phone, c.phone),
    email: pick(d.email, c.email),
    gstin: pick(d.gstin, c.gstin),
    gst_status: pick(d.gst_status, c.gst_status ?? (c.gstin ? 'registered' : '')),
    fssai: pick(d.fssai, c.fssai),
    billing_address: pick(d.billing_address, c.billing_address),
    billing_city: pick(d.billing_city, c.billing_city),
    billing_state: pick(d.billing_state, c.billing_state ?? stateFromGstin(c.gstin ?? '')),
    billing_pin: pick(d.billing_pin, c.billing_pin),
    payment_terms: pick(d.payment_terms, c.payment_terms),
    margin_pct: d.margin_pct ?? c.default_margin ?? null,
  }
  const a = (addrs ?? [])[0]
  if (a && !next.delivery_address) {
    Object.assign(next, {
      address_id: a.id, delivery_name: a.name ?? '', delivery_address: a.address ?? '', delivery_city: a.city ?? '',
      delivery_state: a.state ?? '', delivery_pin: a.pin ?? '', delivery_gstin: a.gstin ?? '', delivery_contact: a.contact_name ?? '', delivery_phone: a.phone ?? '',
    })
  }
  return next
}

// ---------- saving ----------

export interface SaveResult { id: string; orderNo: string }

/** Possible repeat: the same customer with very similar products in the last 3 days. */
export async function findRepeat(d: Draft): Promise<string | null> {
  if (!d.customer_id) return null
  const since = new Date(Date.now() - 3 * 86_400_000).toISOString()
  const { data } = await supabase.from('orders').select('id, order_no, order_lines(sku)')
    .eq('customer_id', d.customer_id).neq('stage', 'cancelled').gte('received_at', since)
  const mine = new Set(d.lines.map((l) => l.sku))
  for (const o of (data ?? []) as { id: string; order_no: string; order_lines: { sku: string }[] }[]) {
    if (o.id === d.id) continue
    const theirs = new Set(o.order_lines.map((l) => l.sku))
    const same = [...mine].filter((s) => theirs.has(s)).length
    if (same && same / Math.max(mine.size, theirs.size) >= 0.6) return o.order_no
  }
  return null
}

export async function saveDraft(d: Draft): Promise<SaveResult> {
  const catalog = await loadCatalog()
  // 1. The customer: add a new one, or fill in details a saved one was missing.
  const custFields = {
    name: d.customer_name, contact_name: d.contact_name, phone: d.phone, email: d.email, gst_status: d.gst_status, gstin: d.gstin,
    fssai: d.fssai, billing_address: d.billing_address, billing_city: d.billing_city, billing_state: d.billing_state,
    billing_pin: d.billing_pin, payment_terms: d.payment_terms, default_channel: d.channel,
    default_margin: d.margin_pct == null ? '' : String(d.margin_pct),
  }
  let customerId = d.customer_id
  if (!customerId) {
    const { data, error } = await supabase.rpc('save_customer', { p_id: null, p: custFields })
    if (error) throw error
    customerId = data as string
  } else {
    const { data: c } = await supabase.from('customers').select('*').eq('id', customerId).single()
    const blanks: Record<string, string> = {}
    for (const [k, v] of Object.entries(custFields)) if (k !== 'name' && v && !c?.[k]) blanks[k] = v
    if (Object.keys(blanks).length) {
      const { error } = await supabase.rpc('save_customer', { p_id: customerId, p: blanks })
      if (error) throw error
    }
  }
  if (d.learn_customer_alias && norm(d.learn_customer_alias) !== norm(d.customer_name)) {
    await supabase.rpc('learn_customer_alias', { p_customer: customerId, p_alias: d.learn_customer_alias })
  }
  // 2. A new delivery address is saved on the customer for next time.
  let addressId = d.address_id
  if (!d.same_as_billing && !addressId && d.delivery_address.trim()) {
    // Reuse the same address if it's already saved (e.g. when a save is tried twice).
    const { data: have } = await supabase.from('customer_addresses').select('id, address').eq('customer_id', customerId)
    addressId = (have ?? []).find((a) => norm(a.address ?? '') === norm(d.delivery_address))?.id ?? null
  }
  if (!d.same_as_billing && !addressId && d.delivery_address.trim()) {
    const { data, error } = await supabase.rpc('save_address', {
      p_id: null, p_customer: customerId,
      p: { name: d.delivery_name, address: d.delivery_address, city: d.delivery_city, state: d.delivery_state, pin: d.delivery_pin, gstin: d.delivery_gstin, contact_name: d.delivery_contact, phone: d.delivery_phone },
    })
    if (error) throw error
    addressId = data as string
  }
  // 3. The order.
  const del = d.same_as_billing
    ? { delivery_name: d.customer_name, delivery_address: d.billing_address, delivery_city: d.billing_city, delivery_state: d.billing_state, delivery_pin: d.billing_pin, delivery_gstin: d.gstin }
    : {}
  const payload = {
    ...d, ...del, customer_id: customerId, address_id: addressId,
    margin_pct: d.margin_pct == null ? '' : String(d.margin_pct),
    lines: d.lines.map((l) => ({ sku: l.sku, qty: l.qty, price_basis: l.price_basis ?? '', margin_pct: l.margin_pct ?? '', rate: l.rate ?? '', typed_as: l.typed_as ?? '' })),
    files: undefined, id: undefined, learn_customer_alias: undefined,
  }
  const { data: id, error } = await supabase.rpc('save_order', { p_id: d.id, p: payload })
  if (error) throw error
  // 4. The original message / screenshot / PO is always kept with the order.
  for (const f of d.files) {
    const blob = await compressImage(f)
    const ext = blob.type === 'image/jpeg' && f.type !== 'image/jpeg' ? 'jpg' : (f.name.split('.').pop() ?? 'bin')
    const safe = f.name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').slice(0, 40) || 'file'
    const path = `${id}/${Date.now()}-${safe}.${ext}`
    const up = await supabase.storage.from('order-files').upload(path, blob, { contentType: blob.type || f.type })
    if (up.error) throw up.error
    const kind = f.type.startsWith('image/') ? 'screenshot' : /pdf|sheet|excel|xls/i.test(f.type + f.name) ? 'po' : 'other'
    await supabase.rpc('add_order_file', { p_order: id, p_path: path, p_kind: kind, p_name: f.name, p_size: blob.size })
  }
  // 5. Remember what the message called each product the person picked.
  let learnt = false
  for (const l of d.lines) {
    if (!l.learn || !l.typed_as) continue
    const p = catalog.bySku.get(l.sku)
    if (p && tidy(l.typed_as) !== tidy(p.name)) { await supabase.rpc('learn_alias', { p_sku: l.sku, p_alias: l.typed_as }); learnt = true }
  }
  for (const l of d.lines) {
    if (l.ean_seen && catalog.bySku.get(l.sku)?.ean !== l.ean_seen) { await supabase.rpc('learn_ean', { p_sku: l.sku, p_ean: l.ean_seen }); learnt = true }
  }
  if (learnt) loadCatalog(true)
  loadCustomersLite(true)
  const { data: o } = await supabase.from('orders').select('order_no').eq('id', id).single()
  return { id: id as string, orderNo: o?.order_no ?? '' }
}

/** Loads a saved order back into a draft, for editing. */
export async function loadDraft(id: string): Promise<Draft> {
  const [{ data: o, error }, { data: lines }] = await Promise.all([
    supabase.from('orders').select('*').eq('id', id).single(),
    supabase.from('order_lines').select('*').eq('order_id', id).order('line_no'),
  ])
  if (error || !o) throw error ?? new Error('Order not found.')
  const s = (v: unknown) => (v == null ? '' : String(v))
  return {
    ...emptyDraft(o.salesperson_id),
    id: o.id, channel: o.channel, order_date: o.order_date, salesperson_id: o.salesperson_id, customer_id: o.customer_id,
    customer_name: o.customer_name, contact_name: s(o.contact_name), phone: s(o.phone), email: s(o.email), gst_status: s(o.gst_status),
    gstin: s(o.gstin), fssai: s(o.fssai), billing_address: s(o.billing_address), billing_city: s(o.billing_city),
    billing_state: s(o.billing_state), billing_pin: s(o.billing_pin), payment_terms: s(o.payment_terms), margin_pct: o.margin_pct,
    same_as_billing: o.same_as_billing, address_id: o.address_id, delivery_name: s(o.delivery_name), delivery_address: s(o.delivery_address),
    delivery_city: s(o.delivery_city), delivery_state: s(o.delivery_state), delivery_pin: s(o.delivery_pin), delivery_gstin: s(o.delivery_gstin),
    delivery_contact: s(o.delivery_contact), delivery_phone: s(o.delivery_phone), po_number: s(o.po_number), po_date: s(o.po_date),
    needed_by: s(o.needed_by), payment_type: s(o.payment_type), courier_pref: s(o.courier_pref), notes: s(o.notes),
    source: o.source, source_text: s(o.source_text),
    lines: (lines ?? []).map((l) => ({ key: newKey(), sku: l.sku, qty: l.qty, typed_as: l.typed_as, price_basis: l.price_basis, margin_pct: l.margin_pct, rate: l.rate, learn: false })),
  }
}

export const MESSAGE_TEMPLATE = `Order for Atom Eats
Store / company name:
Contact person and phone:
GSTIN (if any):
Billing address with PIN:
Delivery address with PIN (if different):
PO number (if any):
Products and quantity:
1.
2.
3.
Margin or agreed rate:
Payment: Prepaid / Credit / COD`
