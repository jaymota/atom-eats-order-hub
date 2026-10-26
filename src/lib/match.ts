// Spelling-tolerant matching of product and customer names, free and in the browser.
// Used by the import script now and by the order form later. No business data in here:
// it only knows how to tidy and compare words.

/** Common misspellings and short forms seen in orders, mapped to one spelling. */
const WORD_FIXES: Record<string, string> = {
  konts: 'knots', kont: 'knots', knot: 'knots', knotts: 'knots', nots: 'knots',
  choc: 'choco', chocolate: 'choco', chocolates: 'choco', choclate: 'choco', chocklate: 'choco', chocolat: 'choco', chco: 'choco',
  maxican: 'mexican', mexicon: 'mexican', mexcian: 'mexican', mexi: 'mexican',
  chili: 'chilli', chilly: 'chilli', chille: 'chilli',
  pretzels: 'pretzel', pretzal: 'pretzel', pretzle: 'pretzel', pretzles: 'pretzel', pretzl: 'pretzel',
  pickles: 'pickle', pikle: 'pickle', pickel: 'pickle', pikles: 'pickle',
  onions: 'onion', oninon: 'onion',
  peanut: 'peanuts', penuts: 'peanuts',
  chip: 'chips', chipps: 'chips',
  stick: 'sticks', stiks: 'sticks', stciks: 'sticks',
  pop: 'pops',
  stawberry: 'strawberry', strawbery: 'strawberry', strwberry: 'strawberry', starwberry: 'strawberry',
  carmel: 'caramel', caramal: 'caramel', caramelised: 'caramel', caramelized: 'caramel',
  tiramishu: 'tiramisu', tiramisoo: 'tiramisu',
  viniger: 'vinegar', vinager: 'vinegar',
  barbeque: 'bbq', barbecue: 'bbq',
  trufle: 'truffle', truffel: 'truffle',
  cinamon: 'cinnamon', cinnemon: 'cinnamon', cinnmon: 'cinnamon',
  chedder: 'cheddar',
  crackers: 'cracker',
  nacho: 'nachos',
  dynamit: 'dynamite',
  periperi: 'peri peri', piri: 'peri',
  pkt: 'pack', pkts: 'pack', packet: 'pack', packets: 'pack', pcs: 'pack', pc: 'pack',
  jars: 'jar', partypack: 'party pack',
  gm: 'g', gms: 'g', gram: 'g', grams: 'g', grm: 'g', gr: 'g',
  n: 'and',
}

/** Words that say nothing about which product it is. */
const NOISE = new Set([
  'atom', 'eats', 'the', 'of', 'a', 'an', 'and', 'in', 'with', 'flavoured', 'flavored', 'flavour', 'flavor',
  'dipped', 'salted', 'ruffled', 'pouch', 'units', 'unit', 'nos', 'qty', 'quantity', 'pieces', 'piece',
])

/** Lower case, letters and digits only, single spaces. Same as the database's norm(). */
export function norm(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** norm() plus spelling fixes, with "30 g" / "30gm" written as "30g". */
export function tidy(s: string | null | undefined): string {
  const t = norm((s ?? '').replace(/&/g, ' and ').replace(/(\d)\s*(kgs?|kilo)\b/gi, '$1kg').replace(/(\d)\s*(g|gm|gms|grams?|grm)\b/gi, '$1g'))
  return t.split(' ').map((w) => WORD_FIXES[w] ?? w).join(' ').replace(/\s+/g, ' ').trim()
}

export interface Features {
  words: string[]          // meaningful words, spelling fixed
  grams: number | null     // pack weight, e.g. 30
  packOf: number | null    // "pack of 3", "x3"
  jar: boolean
  party: boolean
}

export function features(s: string | null | undefined): Features {
  const t = tidy(s)
  let grams: number | null = null
  const g = t.match(/\b(\d+(?:\.\d+)?)(kg|g)\b/)
  if (g) grams = Math.round(Number(g[1]) * (g[2] === 'kg' ? 1000 : 1))
  let packOf: number | null = null
  const p = t.match(/\bpack of (\d+)\b/) ?? t.match(/\b(\d+) ?pack\b/) ?? t.match(/\bx ?(\d+)\b/)
  if (p) packOf = Number(p[1])
  const words = t.split(' ')
    .filter((w) => w && !NOISE.has(w) && !/^\d+(\.\d+)?(g|kg)?$/.test(w) && !['pack', 'box', 'boxes', 'x', 'jar', 'party', 'pp'].includes(w))
  return { words: [...new Set(words)], grams, packOf, jar: /\bjar\b/.test(t), party: /\bparty\b|\bpp\b/.test(t) }
}

/** Edit distance, capped (only used on short words). */
function close(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 4) return false
  // one insertion, deletion or substitution, or two swapped letters
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}

function wordHit(w: string, list: string[]): boolean {
  return list.some((x) => close(w, x) || (w.length >= 4 && x.startsWith(w)) || (x.length >= 4 && w.startsWith(x)))
}

/**
 * How well a typed name matches a product (0 to 1). Words count most; weight, pack size,
 * jar and party pack push the score up when they agree and down when they clearly don't.
 */
export function scoreProduct(query: Features, product: Features & { mrp?: number | null }, queryMrp?: number | null): number {
  if (!query.words.length || !product.words.length) return 0
  const hitsQ = query.words.filter((w) => wordHit(w, product.words)).length
  const hitsP = product.words.filter((w) => wordHit(w, query.words)).length
  // Every typed word should be found; most product words should be covered.
  let s = 0.65 * (hitsQ / query.words.length) + 0.35 * (hitsP / product.words.length)
  if (hitsQ === 0) return 0
  if (query.grams && product.grams) s += query.grams === product.grams ? 0.15 : -0.25
  if (query.jar !== product.jar) s -= query.jar ? 0.2 : 0.05
  if (query.party !== product.party) s -= 0.3
  if ((query.packOf ?? 1) !== (product.packOf ?? 1)) s -= 0.1
  if (queryMrp && product.mrp) s += Math.abs(queryMrp - product.mrp) < 1 ? 0.15 : -0.15
  // Not capped at 1, so a closer size / MRP still ranks higher when two products both look right.
  return Math.max(0, s)
}

/** Words for comparing company names: drops "pvt ltd", "llp", "the", etc. */
export function companyWords(s: string | null | undefined): string[] {
  const stop = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'the', 'and', 'co', 'company', 'india', 'enterprises', 'enterprise', 'store', 'stores', 'm', 's', 'ms', 'sih'])
  return norm(s).split(' ').filter((w) => w && !stop.has(w))
}

/** Similarity of two company names, 0 to 1 (word overlap, typo-tolerant). */
export function nameSimilarity(a: string, b: string): number {
  const wa = companyWords(a)
  const wb = companyWords(b)
  if (!wa.length || !wb.length) return 0
  const hit = wa.filter((w) => wb.some((x) => close(w, x))).length
  const hitB = wb.filter((w) => wa.some((x) => close(w, x))).length
  return (hit + hitB) / (wa.length + wb.length)
}

/** GSTIN check: 15 characters, state code first. Returns the 2-digit state code or null. */
export function gstinState(gstin: string | null | undefined): string | null {
  const g = (gstin ?? '').toUpperCase().replace(/\s/g, '')
  return /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$/.test(g) ? g.slice(0, 2) : null
}

export const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
}
