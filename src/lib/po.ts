// Fixed readers for the POs we get often: Blinkit (Excel + PDF), Foodstories, Food Square (2026 and
// 2024 layouts) and iStore Direct. They work on the text the free PDF / Excel readers give us, so they
// are exact and need no AI. Anything else falls back to the general reader in NewOrder.
import { splitAddress } from './address'
import type { RawItem } from './parse'

export type PoFormat = 'blinkit' | 'foodstories' | 'foodsquare' | 'istore'

export interface PoLine extends RawItem {
  ean?: string
  code?: string   // the buyer's own item code (Article Code / Item Code)
  rate?: number   // per unit, incl. GST
  basic?: number  // per unit, before GST
  mrp?: number
}

export interface PoShip { name: string; address: string; city: string; state: string; pin: string; gstin: string }

export interface PoRead {
  format: PoFormat
  po_number: string
  po_date: string        // yyyy-mm-dd
  delivery_date: string  // yyyy-mm-dd
  payment_terms: string
  revised: boolean
  buyer: string          // store / buyer name to look the customer up with
  gstin: string
  ship: PoShip | null
  items: PoLine[]
}

export const CHANNEL_FOR: Record<PoFormat, string | null> = { blinkit: 'Quick Commerce', foodstories: 'Modern Retail', foodsquare: 'Modern Retail', istore: null }
export const FORMAT_NAME: Record<PoFormat, string> = { blinkit: 'Blinkit', foodstories: 'Foodstories', foodsquare: 'Food Square', istore: 'iStore Direct' }

const OUR_GSTIN = '27ACAFA7039D1ZP'
const num = (s: string | undefined) => Number(String(s ?? '').replace(/,/g, '')) || 0
const round2 = (n: number) => Math.round(n * 100) / 100
const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/g
const theirGstin = (t: string) => (t.match(GSTIN_RE) ?? []).find((g) => g !== OUR_GSTIN) ?? ''
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** "14.10.2026", "02/09/2024", "29-05-2026", "Oct. 12, 2026" → "2026-10-14" */
export function poDate(s: string | undefined): string {
  if (!s) return ''
  let m = /(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(s)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s)
  if (m && MONTHS.includes(m[1].toLowerCase())) return `${m[3]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return ''
}

const grab = (t: string, re: RegExp) => re.exec(t)?.[1]?.trim() ?? ''
/** Address lines → a delivery address. `name` given = the store name, not taken from the lines. */
const shipFrom = (lines: string[], gstin: string, name?: string): PoShip | null => {
  const s = splitAddress(lines, name == null)
  return s.address || s.pin ? { ...s, name: name ?? s.name, gstin } : null
}

// ---------- Blinkit ----------

/** Blinkit's Excel: one row per item, exact. The PO number is in the file name (35460210002616_…xlsx). */
export function blinkitSheet(rows: unknown[][]): PoLine[] {
  const h = rows.findIndex((r) => r.some((c) => /product upc/i.test(String(c))) && r.some((c) => /^quantity$/i.test(String(c).trim())))
  if (h < 0) return []
  const head = rows[h].map((c) => String(c).trim().toLowerCase())
  const col = (name: string) => head.indexOf(name)
  const [cUpc, cDesc, cGram, cLand, cBasic, cQty, cMrp, cCode] =
    ['product upc', 'product description', 'grammage', 'landing rate', 'basic cost price', 'quantity', 'mrp', 'item code'].map(col)
  return rows.slice(h + 1).flatMap((r, k) => {
    const qty = Math.round(num(String(r[cQty] ?? '')))
    const desc = String(r[cDesc] ?? '').trim()
    if (!qty || !desc) return []
    return [{
      text: [desc.replace(/\((packet|jar|pouch|box)\)/i, ''), String(r[cGram] ?? '')].join(' ').replace(/\s+/g, ' ').trim(), qty, line: k,
      ean: String(r[cUpc] ?? '').replace(/\D/g, '') || undefined, code: String(r[cCode] ?? '').trim() || undefined,
      rate: num(String(r[cLand] ?? '')) || undefined, basic: num(String(r[cBasic] ?? '')) || undefined, mrp: num(String(r[cMrp] ?? '')) || undefined,
    }]
  })
}

/** Blinkit's PDF: we only take the header (store, dates, delivery address). Its item table is jumbled. */
export function blinkitHeader(text: string): Omit<PoRead, 'items' | 'format'> | null {
  if (!/Zomato Hyperpure|ZHPL/i.test(text) || !/P\.O\. Number/i.test(text)) return null
  const lines = text.split('\n').map((l) => l.trim())
  const store = lines.find((l) => /^ZHPL\b/.test(l)) ?? ''
  // "Delivered To : Zomato Hyperpure Private Limited  GST No. : 07…", then the address, until the item table (#)
  const at = lines.findIndex((l, i) => /^Delivered\b/.test(l) && /Zomato|Hyperpure/i.test(l) && i > 0)
  const addr: string[] = []
  if (at >= 0) {
    for (const l of lines.slice(at + 1)) {
      if (/^#\s/.test(l) || /^#$/.test(l)) break
      const clean = l.replace(/^To\b\s*/, '').replace(/Reference\s*:.*$/i, '').replace(/\(LGF\)/, '').trim()
      if (clean) addr.push(clean)
    }
  }
  const gstin = grab(lines[at] ?? '', /GST No\.\s*:\s*(\w{15})/) || theirGstin(text)
  return {
    po_number: grab(text, /P\.O\. Number\s*:\s*(\d+)/), po_date: poDate(grab(text, /\bDate\s*:\s*([A-Za-z]{3}\.? \d{1,2}, \d{4})/)),
    delivery_date: poDate(grab(text, /PO delivery date\s*:\s*([A-Za-z]{3}\.? \d{1,2}, \d{4})/i)), payment_terms: grab(text, /Payment Terms\s*:\s*([^\n]+?)(?:\s{2}|$)/m),
    revised: false, buyer: store || 'Zomato Hyperpure', gstin,
    ship: addr.length ? shipFrom([addr.join(' ')], gstin, store || 'Zomato Hyperpure') : null,
  }
}

// ---------- Foodstories ----------

export function foodstories(text: string): PoRead | null {
  if (!/FOODSTORIES/i.test(text) || !/Article Code/i.test(text)) return null
  const lines = text.split('\n').map((l) => l.trim())
  const items: PoLine[] = []
  // Out of state: "EAN  HSN  MRP  QTY  EA  basic  value  IGST %  total".
  // Same state (Mumbai): "EAN  190  MRP  QTY  EA  basic  value  SGST %  CGST %  total" (the HSN wraps onto the next lines).
  const row = /^(\d{12,13})\s+(\d{2,8})\s+([\d,]+\.\d+)\s+([\d,]+\.\d+)\s+EA\s+([\d,]+\.\d+)\s+[\d,]+\.\d+\s+([\d.]+)\s*%(?:\s+([\d.]+)\s*%)?/
  for (let i = 0; i < lines.length; i++) {
    const m = row.exec(lines[i])
    if (!m) continue
    const code = /^(\d{8,10})\b/.exec(lines[i + 1] ?? '')?.[1]
    const name: string[] = []
    for (let j = i + (code ? 2 : 1); j < Math.min(lines.length, i + 7); j++) {
      if (row.test(lines[j]) || /^Total\b/i.test(lines[j]) || !lines[j]) break
      name.push(lines[j].replace(/(\s+\d{1,3})+$/, '')) // drop the wrapped HSN digits ("ATOM EATS  00")
    }
    const basic = num(m[5])
    items.push({ text: name.join(' ').replace(/(\d+)\s*GX(\d+)/i, '$1g pack of $2'), qty: Math.round(num(m[4])), line: i, ean: m[1], code,
      basic, rate: round2(basic * (1 + (num(m[6]) + num(m[7])) / 100)), mrp: num(m[3]) })
  }
  // "Delivery &  FOODSTORIES PRIVATE LIMITED  GST No. : 36…", then "Billing  FOODSTORIES BANJARA HILLS", "Address  …", …
  const at = lines.findIndex((l) => /^Delivery &/.test(l))
  const gstin = grab(lines[at] ?? '', /GST No\.\s*:\s*(\w{15})/) || theirGstin(text)
  const block: string[] = []
  for (const l of lines.slice(at + 1)) {
    if (/^Article Code/i.test(l)) break
    block.push(l.replace(/^(Billing|Address)\s{2,}/, ''))
  }
  return {
    format: 'foodstories', po_number: grab(text, /P\.\s?O\. Number\s*:\s*(\d+)/), po_date: poDate(grab(text, /\bDate\s*:\s*([\d.]+)/)),
    delivery_date: poDate(grab(text, /PO Delivery date\s*:\s*([\d.]+)/i)), payment_terms: grab(text, /Payment Terms\s*:\s*([^\n]+?)(?:\s{2}|$)/m),
    revised: /revised/i.test(text.slice(0, 2000)), buyer: block[0] ?? 'Foodstories', gstin,
    ship: at >= 0 ? shipFrom(block, gstin) : null, items,
  }
}

// ---------- Food Square ----------

export function foodsquare(text: string): PoRead | null {
  if (!/FOOD SQUARE|Landcraft Retail/i.test(text)) return null
  const lines = text.split('\n').map((l) => l.trim())
  const items: PoLine[] = []
  // 2026: "1  0745314461054  ATOM EATS CARAMEL  190540  24  Unit  120  68.57  1645.68  2.5  2.5  0  1727.96"
  const row26 = /^(\d{1,3})\s+(\d{12,13})\s+(.+?)\s+(\d{6})\s+(\d+)\s+(?:Unit|EA|PCS|Nos?)\s+([\d.]+)\s+([\d.]+)\s+[\d.]+\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+[\d.]+$/i
  // 2024: "1  / 9041037  ATOM EATS AMERICAN  19053211  6  203.39  0.00  400  1220.34  18  219.66  1440"
  const row24 = /^(\d{1,3})\s+(\d{12,13})?\s*\/\s*(\d{6,8})\s+(.+?)\s+(\d{8})\s+(\d+)\s+([\d.]+)\s+[\d.]+\s+([\d.]+)\s+[\d.]+\s+([\d.]+)\s+[\d.]+\s+([\d.]+)$/
  for (let i = 0; i < lines.length; i++) {
    let m = row26.exec(lines[i])
    if (m) {
      const name = [m[3]]
      const next = /^(\d{6,8})\s+(.+?)\s+\d{2}\s+[\d.]+\s+[\d.]+\s+[\d.]+$/.exec(lines[i + 1] ?? '')
      if (next) name.push(next[2])
      const tail = /^\d{12,13}\s+([A-Za-z].*)$/.exec(lines[i + 2] ?? '') // "0745314460729  G"
      if (tail) name.push(tail[1])
      const basic = num(m[7])
      items.push({ text: name.join(' ').replace(/(\d+)\s+G\b/i, '$1G').replace(/`/g, ''), qty: Math.round(num(m[5])), line: i, ean: m[2].replace(/^0(?=\d{12}$)/, ''),
        code: next?.[1], basic, rate: round2(basic * (1 + (num(m[8]) + num(m[9]) + num(m[10])) / 100)), mrp: num(m[6]) })
      continue
    }
    m = row24.exec(lines[i])
    if (m) {
      const name = [m[4]]
      const nx = lines[i + 1] ?? ''
      if (nx && !row24.test(nx) && !/^Gross Total/i.test(nx) && /[A-Za-z]{2}/.test(nx)) name.push(nx)
      const qty = Math.round(num(m[6]))
      items.push({ text: name.join(' '), qty, line: i, ean: m[2], code: m[3], basic: num(m[7]), rate: qty ? round2(num(m[10]) / qty) : undefined, mrp: num(m[8]) })
    }
  }
  if (!items.length) return null
  // 2026: "BILLING ADDRESS  SHIPPING ADDRESS", then lines holding both columns side by side: keep the right half.
  let ship: PoShip | null = null
  let buyer = 'Food Square'
  const at = lines.findIndex((l) => /BILLING ADDRESS\s+SHIPPING ADDRESS/i.test(l))
  const gstin = theirGstin(text)
  if (at >= 0) {
    const block: string[] = []
    for (const l of lines.slice(at + 1, at + 4)) {
      if (/^GST No/i.test(l)) break
      const parts = l.split(/\s{2,}/)
      block.push(parts.slice(Math.ceil(parts.length / 2)).join(' ').replace(/\s+,\s+/g, ', ').replace(/,\s*[EW]\b/g, '').replace(/\s+/g, ' '))
    }
    const joined = block.join(' ')
    buyer = joined.split(',')[0].trim() || buyer
    ship = shipFrom([joined.slice(joined.indexOf(',') + 1)], gstin, buyer)
  }
  return {
    format: 'foodsquare', po_number: grab(text, /PO No\s*:\s*(\d+)/), po_date: poDate(grab(text, /PO Date\s*:\s*([\d/]+)/)),
    delivery_date: poDate(grab(text, /Delivery Date\s*:\s*([\d/]+)/)), payment_terms: '', revised: /revised/i.test(text.slice(0, 1500)),
    buyer, gstin, ship, items,
  }
}

// ---------- iStore Direct (Urban Platter) ----------

export function istore(text: string): PoRead | null {
  if (!/ISTORE DIRECT/i.test(text)) return null
  const lines = text.split('\n').map((l) => l.trim())
  const row = /^(\d{1,3})\s+(.+?)\s+(\d{8})\s+(\d+)\s*\((?:PCS|NOS?|EA|UNITS?)\)\s+([\d.]+)\s+([\d.]+)%\s+[\d,.]+$/i
  const items: PoLine[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = row.exec(lines[i])
    if (!m) continue
    let name = m[2]
    const nx = lines[i + 1] ?? ''
    if (nx && !row.test(nx) && !/^Subtotal/i.test(nx) && nx.length < 30) name += nx // "…Party Pac" + "k, 200g"
    const basic = num(m[5])
    items.push({ text: name, qty: Math.round(num(m[4])), line: i, basic, rate: round2(basic * (1 + num(m[6]) / 100)) })
  }
  return {
    format: 'istore', po_number: grab(text, /PO NO\s*:\s*(\S+)/), po_date: poDate(grab(text, /\bDate\s*:\s*([\d-]+)/)), delivery_date: '',
    payment_terms: grab(text, /Payment Term\s*:\s*([^\n]+?)(?:\s{2}|$)/m), revised: false, buyer: 'Istore Direct Trading Private Limited',
    gstin: theirGstin(text), ship: null, items,
  }
}

// ---------- All files of one PO together ----------

export interface PoFile { name: string; text?: string; rows?: unknown[][] }

/** Reads a PO from its files (e.g. Blinkit's Excel + PDF). Returns null when no fixed reader knows it. */
export function readPo(files: PoFile[], subject = ''): PoRead | null {
  const revised = /revised/i.test(subject)
  for (const f of files) {
    if (!f.text) continue
    const r = foodstories(f.text) ?? foodsquare(f.text) ?? istore(f.text)
    if (r && r.items.length) return { ...r, revised: r.revised || revised }
  }
  const sheet = files.find((f) => f.rows && blinkitSheet(f.rows).length)
  const head = files.map((f) => (f.text ? blinkitHeader(f.text) : null)).find(Boolean)
  if (sheet) {
    return {
      po_number: /(\d{12,16})_/.exec(sheet.name)?.[1] ?? /PO_\w*?(\d{12,16})/.exec(subject)?.[1] ?? '', po_date: '', delivery_date: '', payment_terms: '',
      buyer: 'Zomato Hyperpure', gstin: '', ship: null, ...(head ?? {}), revised, format: 'blinkit', items: blinkitSheet(sheet.rows!),
      // The Excel's file name carries the PO number of these items.
      ...(/(\d{12,16})_/.test(sheet.name) ? { po_number: /(\d{12,16})_/.exec(sheet.name)![1] } : {}),
    }
  }
  return null
}
