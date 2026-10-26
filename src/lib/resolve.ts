// Turns what a message says into Easy Ecom SKUs and a customer, and decides what still
// needs a question. Uses the product list, its other names and the nicknames the team
// has confirmed. Free and in the browser.
import type { Catalog, Product } from './catalog'
import { features, nameSimilarity, norm, scoreProduct, tidy, type Features } from './match'
import { windows, type RawItem } from './parse'

export interface ResolvedItem {
  raw: RawItem
  typed: string            // the words that named the product, e.g. "dill pikle"
  qty: number | null
  sku: string | null       // set when the Hub is sure
  options: Product[]       // closest products, best first (for the question)
  sure: boolean
}

interface Cand { p: Product; feats: Features[] }

const indexCache = new WeakMap<Catalog, { cands: Cand[]; exact: Map<string, string> }>()

/** Products that can go on an offline order, with every name they're known by. */
function index(c: Catalog) {
  const hit = indexCache.get(c)
  if (hit) return hit
  const exact = new Map<string, string>()
  const clash = new Set<string>()
  const put = (text: string, sku: string) => {
    const k = tidy(text)
    if (!k) return
    if (exact.has(k) && exact.get(k) !== sku) clash.add(k)
    else exact.set(k, sku)
  }
  const cands: Cand[] = []
  for (const p of c.products) {
    if (!p.is_offline || p.replaced_by) continue
    const texts = [`${p.name} ${p.size ?? ''}`]
    put(texts[0], p.sku)
    for (const a of c.aliasesBySku.get(p.sku) ?? []) {
      if (a.status === 'rejected' || a.kind === 'ean') continue
      texts.push(a.alias)
      if (a.status === 'confirmed' && ['nickname', 'tally', 'retail_form', 'customer_code', 'shopify'].includes(a.kind)) put(a.alias, p.sku)
    }
    cands.push({ p, feats: texts.map((t) => ({ ...features(t), mrp: p.mrp } as Features)) })
  }
  for (const k of clash) exact.delete(k)
  const built = { cands, exact }
  indexCache.set(c, built)
  return built
}

// Words that mean "a particular size" — if the message says one and the name it matched
// doesn't cover it, the Hub asks instead of guessing.
const SIZE_HINT = /^(small|smaller|smallest|big|bigger|biggest|large|jumbo|jar|jars|pouch|party|pp|bulk|family|mini|tiny|kg|\d+g|\d+kg)$/
// Everyday words that are never a product on their own (stops "will" matching "dill").
const COMMON = new Set(['will', 'get', 'got', 'the', 'details', 'detail', 'billing', 'bill', 'order', 'orders', 'confirm', 'confirmed', 'please', 'need', 'needed', 'today', 'tomorrow', 'send', 'share', 'address', 'invoice', 'payment', 'total', 'event', 'client', 'party', 'personal', 'place', 'week', 'thursday', 'friday', 'monday', 'tuesday', 'wednesday', 'saturday', 'sunday', 'dispatch', 'shipped', 'express', 'evening', 'morning', 'good', 'know', 'let', 'pay', 'can', 'how', 'what', 'when', 'this', 'that', 'there', 'here', 'have', 'has', 'with', 'from', 'for', 'and', 'pack', 'packs', 'box', 'boxes', 'pieces', 'piece', 'outlet', 'store', 'shop', 'mix', 'small', 'big'])

function rank(cands: Cand[], text: string) {
  const q = features(text)
  return cands
    .map((c) => ({ p: c.p, s: Math.max(...c.feats.map((f) => scoreProduct(q, f))) }))
    .sort((a, b) => b.s - a.s)
}

/** Works out which product each phrase means, and whether the Hub is sure. */
export function resolveItems(c: Catalog, items: RawItem[]): ResolvedItem[] {
  const { cands, exact } = index(c)
  const out: ResolvedItem[] = []
  for (const raw of items) {
    const ws = windows(raw.text).filter((w) => w.split(' ').some((x) => !COMMON.has(x.toLowerCase()) && x.length >= 3))
    const phraseWords = tidy(raw.text).split(' ')
    const hintsLeft = (w: string) => {
      const used = new Set(tidy(w).split(' '))
      return phraseWords.filter((x) => SIZE_HINT.test(x) && !used.has(x))
    }
    const small = phraseWords.some((x) => /^(small|smaller|smallest|mini|tiny)$/.test(x))
    const order = (list: Product[]) => (small ? [...list].sort((a, b) => (features(a.size).grams ?? 999) - (features(b.size).grams ?? 999)) : list)

    // 1. A known name or nickname in the phrase (longest first) = sure, unless the message
    //    also names a size that the known name doesn't cover ("truffle peanuts small pack").
    const known = ws.find((w) => exact.has(tidy(w)))
    if (known && !hintsLeft(known).length) {
      const p = c.bySku.get(exact.get(tidy(known))!)!
      out.push({ raw, typed: known, qty: raw.qty, sku: p.sku, options: [p], sure: true })
      continue
    }
    // 2. Otherwise the closest products, trying each stretch of the phrase.
    let best = { w: raw.text, ranked: rank(cands, raw.text) }
    for (const w of ws.slice(0, 40)) {
      const r = rank(cands, w)
      if ((r[0]?.s ?? 0) > (best.ranked[0]?.s ?? 0) + 0.02) best = { w, ranked: r }
    }
    // With a size word, rank on the matched words plus the size words, so "party", "jar"
    // and "small" count ("Party pack sticks" → the sticks party pack).
    const hints = hintsLeft(known ?? best.w)
    const kp = known ? c.bySku.get(exact.get(tidy(known))!)! : null
    if (hints.length) best = { w: known ?? best.w, ranked: rank(cands, `${known ?? best.w} ${hints.join(' ')}`) }
    const top = best.ranked[0]
    const second = best.ranked[1]
    const floor = raw.qty != null ? 0.45 : 0.75 // a phrase without a number must look clearly like a product
    if (!ws.length || (!kp && (!top || top.s < floor))) continue
    const sure = !hints.length && top.s >= 1 && top.s - (second?.s ?? 0) >= 0.2
    let options = best.ranked.filter((x) => x.s >= Math.max(0.35, top.s - 0.45)).slice(0, 5).map((x) => x.p)
    if (kp) {
      // The same product in its other sizes, so "small pack" is one tap.
      const base = features(kp.name).words
      const sizes = cands.map((x) => x.p).filter((p) => p.sku !== kp.sku && base.every((w) => features(p.name).words.includes(w)))
      const family = order([kp, ...sizes])
      options = hints.length && !small ? [...options, ...family] : [...family, ...options]
    }
    options = options.filter((p, i) => options.findIndex((x) => x.sku === p.sku) === i).slice(0, 3)
    // With a size word, the words to remember are the whole phrase ("party pack sticks"), not just "sticks".
    const typed = hints.length ? (raw.text.split(/\s+/).length <= 6 ? raw.text : `${hints.join(' ')} ${known ?? best.w}`) : best.w
    out.push({ raw, typed, qty: raw.qty, sku: sure ? top.p.sku : null, options, sure })
  }
  return out
}

// ---------- customers ----------

export interface CustomerLite {
  id: string
  code: string
  name: string
  phone: string | null
  gstin: string | null
  billing_city: string | null
  default_channel: string | null
  default_margin: number | null
  active: boolean
}

export interface CustomerGuess {
  matches: { c: CustomerLite; why: string }[]  // best first
  sure: boolean
  nameLine: string | null                      // the line that named the customer (to learn it)
}

/** Finds the customer from a phone number, GSTIN, or a line naming them. */
export function resolveCustomer(
  customers: CustomerLite[],
  aliases: Map<string, string[]>, // customer id → other names (normalised)
  info: { phones: string[]; gstins: string[]; lines: string[]; addressLines: Set<number> },
): CustomerGuess {
  const live = customers.filter((c) => c.active)
  const found = new Map<string, { c: CustomerLite; why: string; w: number }>()
  const add = (c: CustomerLite, why: string, w: number) => {
    const prev = found.get(c.id)
    if (!prev) found.set(c.id, { c, why, w })
    else if (!prev.why.includes(why)) found.set(c.id, { c, why: `${prev.why}, ${why}`, w: prev.w + w })
  }
  for (const g of info.gstins) for (const c of live) if (c.gstin === g) add(c, 'same GSTIN', 3)
  for (const ph of info.phones) for (const c of live) if (c.phone && c.phone.slice(-10) === ph) add(c, 'same phone number', 2.5)
  let nameLine: string | null = null
  for (const line of info.lines) {
    const ln = norm(line)
    if (ln.length < 4 || ln.split(' ').length > 8) continue
    for (const c of live) {
      const names = [norm(c.name), ...(aliases.get(c.id) ?? [])]
      if (names.includes(ln)) { add(c, 'name in the message', 2.2); nameLine = line }
      else if (nameSimilarity(line, c.name) >= 0.85) { add(c, 'similar name in the message', 1.5); nameLine ??= line }
    }
  }
  const matches = [...found.values()].sort((a, b) => b.w - a.w).slice(0, 4)
  // Sure only when one customer clearly stands out (e.g. GSTIN of one customer but the
  // name of another is not sure).
  const sure = matches.length > 0 && matches[0].w >= 2.2 && (matches.length === 1 || matches[1].w < 1.5)
  return { matches: matches.map(({ c, why }) => ({ c, why })), sure, nameLine }
}

/** Likely names for a new customer, best first: the first line of the billing block or of an
 *  address, a name before the first comma of an address, or short lines like "Colaba outlet". */
export function guessCustomerNames(lines: string[], addressLines: Set<number>, billingStart: number | null, itemLines: Set<number>, deliveryStart: number | null = null): string[] {
  const looksLikeAddress = (l: string) => /\d/.test(l) || /\b(road|marg|floor|nagar|sector|block|colony|lane|street|opp|near|estate|mumbai|delhi|bangalore|bengaluru|pune)\b/i.test(l)
  const chatty = /\b(please|plz|pls|need|send|dispatch|order|good|hi|hey|hello|thanks|share|confirm|can we|will|let me|today|tomorrow|week)\b/i
  const out: string[] = []
  const push = (l: string | undefined) => {
    const v = (l ?? '').replace(/^[\s,:;-]+|[\s,:;-]+$/g, '').trim()
    if (v && v.length >= 3 && v.length <= 60 && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v)
  }
  // Lines under a "Delivery address" heading name a place, not the customer (unless that's all there is).
  const inDelivery = (i: number) => deliveryStart != null && i > deliveryStart && (billingStart == null || billingStart < deliveryStart)
  const order = [...addressLines].filter((i) => !itemLines.has(i) && !inDelivery(i)).sort((a, b) => a - b)
  const fromBilling = billingStart != null ? order.filter((i) => i > billingStart) : []
  for (const i of [...fromBilling, ...order]) {
    const l = lines[i]
    if (!l) continue
    if (!looksLikeAddress(l)) { push(l); break }
    // "Reem Khokhar, 531, Air Force …": a name, then the house number.
    const [head, next] = l.split(',').map((x) => x.trim())
    if (head && !looksLikeAddress(head) && head.split(' ').length <= 4 && /^\d/.test(next ?? '')) { push(head); break }
  }
  // Short lines that could be a name, closest to an address first (the sender's name is usually at the top).
  const addr = [...addressLines]
  const dist = (i: number) => (addr.length ? Math.min(...addr.map((a) => Math.abs(a - i))) : i)
  const short: { v: string; d: number }[] = []
  lines.forEach((l, i) => {
    if (!l || addressLines.has(i) || itemLines.has(i) || chatty.test(l) || /^(?:gstin|gst|contact|phone|margin|po)\b/i.test(l)) return
    if (/^\d+\s*[a-z]{0,6}$/i.test(l) || /^(?:pkts?|pcs|qty|nos)$/i.test(l) || /^(?:billing|bill to|delivery|del\.? ?add|shipping|ship to)\b/i.test(l)) return
    if (l.split(/\s+/).length <= 5 && !/\d{3,}/.test(l)) short.push({ v: l, d: dist(i) })
    const afterPhone = /\d{5}\s*-\s*([a-z][a-z .]{2,40})$/i.exec(l)?.[1]
    if (afterPhone) short.push({ v: afterPhone, d: dist(i) })
  })
  short.sort((a, b) => a.d - b.d).forEach((x) => push(x.v))
  return out.slice(0, 5)
}
