// Reads an order message (pasted WhatsApp text, or text read from a screenshot / PO) with
// simple rules. Free: no AI service. It finds the details it can be sure of and leaves the
// rest for the order form to ask about.

export interface RawItem {
  text: string          // the words around the quantity, e.g. "truffle peanuts small pack"
  qty: number | null    // null when the message gave no number
  line: number          // index into `lines`
}

export interface ReadMessage {
  lines: string[]               // cleaned lines (blank lines kept as '')
  addressLines: Set<number>     // lines that look like part of an address
  addressHeads: Set<number>     // the line just above an address: often the customer's name
  billingStart: number | null   // line index of a "Billing address" heading, if any
  deliveryStart: number | null  // line index of a "Delivery address" heading, if any
  phones: string[]
  gstins: string[]
  pins: string[]
  emails: string[]
  poNumbers: string[]
  margin: number | null
  fssai: string | null
  items: RawItem[]
}

const TIME = /\b\d{1,2}[:.]?\d{2}\s*(?:am|pm)\b/gi
const WA_PREFIX = /^\[?\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\]?\s*(?:-\s*)?[^:]{1,40}:\s*/i
const JUNK_LINE = /^(?:[→>»\s]*forwarded|<?\s*(?:image|media|video|sticker|gif|document|audio) omitted\s*>?|this message was deleted|you deleted this message|edited|✓+|v{2,}|\d{1,2}:\d{2}\s*(?:am|pm)?)$/i

/** Tidies a pasted chat or OCR text: drops times, "Forwarded", "image omitted", WhatsApp name prefixes. */
export function cleanMessage(raw: string, ignoreNames: string[] = []): string[] {
  const names = ignoreNames.map((n) => n.toLowerCase().trim()).filter(Boolean)
  return raw
    .replace(/\r/g, '')
    .replace(/[‎‏‪-‮]/g, '')
    .split('\n')
    .map((l) => l.replace(WA_PREFIX, '').replace(TIME, '').replace(/[✓✔]+\s*$/g, '').replace(/\s+/g, ' ').trim())
    .map((l) => (JUNK_LINE.test(l) ? '' : l))
    .map((l) => l.replace(/@\S+(?:\s+[A-Z][a-z]+)?/g, '').trim()) // @mentions
    .filter((l, i, all) => !(l === '' && all[i - 1] === ''))
    .filter((l) => !names.some((n) => l.toLowerCase() === n || (l.length <= n.length + 4 && l.toLowerCase().endsWith(n))))
}

/**
 * Text read from a screenshot: removes stray symbols the reader adds at the edges of chat
 * bubbles, and re-joins lines that WhatsApp wrapped because the bubble was narrow.
 * (The screen reader can't be trusted with blank lines, so those are dropped.)
 */
export function cleanOcr(text: string): string {
  const lines = text.replace(/\r/g, '').split('\n')
    .map((l) => l
      .replace(/^[\s|)\]}»>&©®~\\/•*.,]+(?=\S)/, '')
      .replace(/\s+(?:v|vw|ww|w|v\/|©|®|\[@\)|@\)|\(@|py|~\\n\/)$/i, '')
      .replace(TIME, '')
      .trim())
    .filter((l) => l && !/^[^a-z0-9]{1,4}$/i.test(l))
  const longest = Math.max(...lines.map((l) => l.length), 1)
  const out: string[] = []
  for (const l of lines) {
    const prev = out[out.length - 1]
    const wrapped = prev && prev.length >= longest * 0.72 && !/[.!?:]$/.test(prev) && (/^[a-z(]/.test(l) || /\d$/.test(prev))
    if (wrapped) out[out.length - 1] = `${prev} ${l}`
    else out.push(l)
  }
  return out.join('\n')
}

const ADDRESS_WORDS = /\b(road|rd|marg|floor|flr|building|bldg|apartments?|apts?|society|soc|nagar|sector|plot|colony|block|lane|street|near|opp|opposite|chawl|estate|enclave|tower|wing|phase|layout|cross|main|industrial|compound|complex|house|villa|flat|shop|unit|gala|mumbai|delhi|new delhi|bangalore|bengaluru|pune|hyderabad|chennai|kolkata|thane|navi mumbai|gurgaon|gurugram|noida|maharashtra|karnataka|telangana|tamil nadu|haryana|west|east|north|south)\b/i
const PIN = /(?<!\d)([1-9]\d{2}\s?\d{3})(?!\d)/
const BILLING_HEAD = /^(?:billing|bill to|billing address|billing details|invoice to|invoice address)\b/i
const DELIVERY_HEAD = /^(?:delivery|deliver to|del\.? ?add|del address|shipping|ship to|dispatch to|delivery address)\b/i

const UNIT = '(?:x|qty|nos?|pcs?|pieces?|pkts?|packets?|packs?|units?|boxes|box|jars?|pouches?|cartons?|bags?)'

/** Finds the details a message states outright. */
export function readMessage(raw: string, ignoreNames: string[] = []): ReadMessage {
  const lines = cleanMessage(raw, ignoreNames)
  const text = lines.join('\n')

  const phones = [...new Set([...text.matchAll(/(?:\+?91[\s-]?)?(?<!\d)([6-9]\d{4}[\s-]?\d{5})(?!\d)/g)].map((m) => m[1].replace(/\D/g, '')))]
  // (A screenshot reader sometimes reads the GSTIN's "Z" as "2"; it is always Z.)
  const gstins = [...new Set([...text.toUpperCase().matchAll(/\b(\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z][Z2][0-9A-Z])\b/g)].map((m) => m[1].slice(0, 13) + 'Z' + m[1][14]))]
    .filter((g) => !OWN_GSTINS.includes(g))
  const emails = [...new Set([...text.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)].map((m) => m[0].toLowerCase()))]
  const fssai = /\bfssai\D{0,12}(\d{14})\b/i.exec(text)?.[1] ?? null
  const margin = (() => {
    const m = /\bmargin\s*[:=-]?\s*(\d{1,2}(?:\.\d+)?)\s*%?/i.exec(text) ?? /(\d{1,2}(?:\.\d+)?)\s*%\s*margin/i.exec(text)
    return m ? Number(m[1]) : null
  })()
  const poNumbers = [...new Set([...text.matchAll(/\b(?:po|p\.o\.|purchase order)\s*(?:no\.?|number|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_-]{3,})/gi)].map((m) => m[1]).filter((p) => /\d/.test(p)))]

  // ---- address lines: each PIN code line plus the lines above it that look like an address,
  //      and the lines under a "Billing address" / "Delivery address" heading.
  const addressLines = new Set<number>()
  const addressHeads = new Set<number>()
  let billingStart: number | null = null
  let deliveryStart: number | null = null
  const pins: string[] = []
  const isPinLine = (l: string) => PIN.test(l) && !/\d{7,}/.test(l.replace(/\s/g, ''))
  const stopper = (l: string) => /^(?:\d+\s*(?:x|qty|pkts?|pcs)\b|need|needed|please|plz|pls|kindly|send|hi|hey|hello|good|confirm|share|can we|we need|order)/i.test(l)
    || /^(?:gstin|gst no|contact|phone|mob|margin|po)\b/i.test(l)
  const isHead = (l: string) => BILLING_HEAD.test(l) || DELIVERY_HEAD.test(l)
  lines.forEach((l, i) => {
    if (BILLING_HEAD.test(l)) billingStart = i
    else if (DELIVERY_HEAD.test(l)) deliveryStart = i
  })
  lines.forEach((l, i) => {
    if (!isPinLine(l)) return
    const p = PIN.exec(l)![1].replace(/\s/g, '')
    if (!pins.includes(p)) pins.push(p)
    addressLines.add(i)
    for (let j = i - 1, n = 0; j >= 0 && n < 7; j--, n++) {
      const u = lines[j]
      if (u === '' || isHead(u) || isPinLine(u) || stopper(u)) break
      addressLines.add(j)
      // The first line that doesn't look like an address (no number, comma or street word)
      // is usually the name ("Nutshell") — or a product line just above the address.
      if (!/\d|,/.test(u) && !ADDRESS_WORDS.test(u)) { addressHeads.add(j); break }
    }
  })
  for (const head of [billingStart, deliveryStart]) {
    if (head == null) continue
    let started = false
    for (let j = head + 1, n = 0; j < lines.length && n < 9; j++) {
      const u = lines[j]
      if (u === '') { if (started) break; continue }
      if (isHead(u) || stopper(u)) break
      started = true
      n++
      addressLines.add(j)
      if (isPinLine(u)) break
    }
  }

  // ---- product lines
  // Heads stay readable as product lines too; the product matcher decides.
  const items = readItems(lines, new Set([...addressLines].filter((i) => !addressHeads.has(i))))
  return { lines, addressLines, addressHeads, billingStart, deliveryStart, phones, gstins, pins, emails, poNumbers, margin, fssai, items }
}

type Tok =
  | { kind: 'word'; w: string; line: number }
  | { kind: 'num'; n: number; unit: string; line: number; sep: boolean; wordAfter: boolean }
  | { kind: 'nl'; line: number }

// Units that only ever follow a number ("3 pkt"); "pack", "box", "jar" stay in the name.
const QTY_UNIT = /^(?:x|qty|nos?|pcs?|pieces?|pkts?|packets?|units?)$/i
const ANY_UNIT = new RegExp(`^${UNIT}$`, 'i')
const FILLER = new Set(['need', 'needed', 'please', 'plz', 'pls', 'kindly', 'send', 'make', 'pi', 'order', 'want', 'wanted', 'hi', 'hii', 'hello', 'hey', 'dear', 'sir', 'madam', 'mam', 'for', 'the', 'and', 'of', 'with', 'to', 'we', 'i', 'me', 'us', 'can', 'you', 'get', 'add', 'more', 'also', 'total', 'only', 'urgent', 'today', 'tomorrow', 'ok', 'okay', 'thanks', 'thank'])

function tokenize(lines: string[], skip: Set<number>): Tok[] {
  const toks: Tok[] = []
  lines.forEach((raw, line) => {
    if (skip.has(line) || raw === '' || BILLING_HEAD.test(raw) || DELIVERY_HEAD.test(raw)) { toks.push({ kind: 'nl', line }); return }
    if (/^(?:gstin|gst no|gst|contact|phone|mob(?:ile)?|fssai|margin|po|email|pan)\b/i.test(raw)) { toks.push({ kind: 'nl', line }); return }
    const l = raw
      .replace(/^\s*\d{1,2}[.)]\s*(?=[a-z])/i, '')            // "1.Cream n onion" list numbers
      .replace(/(\d)\s*(qty|pcs|pkts?|nos)\b/gi, '$1 $2')     // "102QTY" → "102 QTY"
      .replace(/\b(\d+)\s*[x×]\s*(?=[a-z])/gi, '$1 x ')       // "2x salt" → "2 x salt"
      .replace(/[*×]\s*(\d+)/g, ' * $1')                      // "200g*8" → "200g * 8"
    const re = /[\w'’&./#₹%+-]+|[:*=]/g
    const words = l.match(re) ?? []
    for (let k = 0; k < words.length; k++) {
      const w = words[k]
      const prev = words[k - 1] ?? ''
      if (/^\d{1,4}$/.test(w) && !/^(?:g|gm|gms|kg|ml|rs|%)$/i.test(words[k + 1] ?? '') && prev.toLowerCase() !== 'of' && !/^(?:rs\.?|₹|mrp)$/i.test(prev)) {
        const unit = words[k + 1] && ANY_UNIT.test(words[k + 1]) ? words[k + 1].toLowerCase() : ''
        if (unit) k++
        const after = words.slice(k + 1).some((x) => /^[a-z]/i.test(x))
        toks.push({ kind: 'num', n: Number(w), unit, line, sep: /^[-:*=]$/.test(prev), wordAfter: after })
      } else if (/^[a-z&][\w'’&.-]*$/i.test(w) && !QTY_UNIT.test(w)) {
        toks.push({ kind: 'word', w: w.replace(/[.,:;!?-]+$/, ''), line })
      } else if (/^\d+(?:\.\d+)?(?:g|gm|gms|kg|ml)$/i.test(w)) {
        toks.push({ kind: 'word', w, line }) // "30g" belongs to the name
      }
    }
    toks.push({ kind: 'nl', line })
  })
  return toks
}

/** Walks the words and numbers, pairing each product phrase with its quantity. */
export function readItems(lines: string[], skip: Set<number> = new Set()): RawItem[] {
  const toks = tokenize(lines, skip)
  const out: RawItem[] = []
  let words: string[] = []
  let qty: number | null = null
  let line = -1
  const close = () => {
    const text = words.join(' ').replace(/^(?:(?:and|of|the|with|for)\s+)+|(?:\s+(?:and|of|the|with|for))+$/gi, '').trim()
    const meaningful = text.toLowerCase().split(/\s+/).filter((x) => !FILLER.has(x))
    if (text && meaningful.some((x) => /[a-z]{3}/.test(x))) out.push({ text, qty, line })
    words = []
    qty = null
    line = -1
  }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.kind === 'word') {
      if (line < 0) line = t.line
      words.push(t.w)
    } else if (t.kind === 'num') {
      // A number belongs to the words before it ("knots 3 pkt", "chips - 50 units") or to the
      // words after it ("2 x hot honey", "for 10 party pack sticks").
      const before = !t.sep && t.wordAfter && !(QTY_UNIT.test(t.unit) && t.unit !== 'x' && t.unit !== 'qty' && words.length && qty == null && !t.wordAfter)
      if (words.length && qty == null && !before) {
        qty = t.n
        close()
      } else {
        if (words.length) close()
        qty = t.n
      }
    } else {
      // End of a line. Keep a phrase open only if the next line is just a quantity ("3 pkt").
      if (!words.length) { if (qty != null && toks[i + 1]?.kind !== 'word') qty = null; continue }
      if (qty != null) { close(); continue }
      const a = toks[i + 1]
      const b = toks[i + 2]
      if (!(a?.kind === 'num' && (b?.kind === 'nl' || !b))) close()
    }
  }
  if (words.length) close()
  return out
}

/** Every 1–6 word stretch of a phrase, longest first, for finding the product name inside a sentence. */
export function windows(text: string, max = 6): string[] {
  const w = text.split(/\s+/).filter(Boolean)
  const out: string[] = []
  for (let len = Math.min(max, w.length); len >= 1; len--) {
    for (let s = 0; s + len <= w.length; s++) out.push(w.slice(s, s + len).join(' '))
  }
  return out
}

export interface BarcodeItem extends RawItem {
  ean: string
  basic?: number   // cost per pack before GST, as printed on the PO
}

/**
 * PO tables (Foodstories, Food Square, Blinkit PDFs…): each item row starts with the
 * product's barcode, then numbers (HSN, MRP, quantity, cost…), and the name on the lines
 * just below. Reads the barcode, the quantity (the number before "EA" / "PCS" / "NOS"),
 * the cost before GST, and the name.
 */
export function readBarcodeRows(lines: string[]): BarcodeItem[] {
  const out: BarcodeItem[] = []
  const end = lines.findIndex((l) => /terms\s*(?:&|and)\s*conditions/i.test(l))
  const ls = end > 0 ? lines.slice(0, end) : lines
  for (let i = 0; i < ls.length; i++) {
    const m = /(?:^|\s)(\d{12,13})(?=\s)/.exec(ls[i])
    if (!m) continue
    const rest = ls[i].slice(m.index + m[0].length)
    const q = /(\d+(?:\.\d+)?)\s*(?:EA|EACH|PCS?|NOS?|UNITS?|PKT|CS)\b/i.exec(rest)
    const nums = [...rest.matchAll(/(\d[\d,]*\.\d+|\d+)/g)].map((x) => Number(x[1].replace(/,/g, '')))
    const qty = q ? Math.round(Number(q[1])) : null
    // cost before GST: the first number after the quantity
    const afterQty = q ? rest.slice(rest.indexOf(q[0]) + q[0].length) : ''
    const basic = Number(/(\d[\d,]*\.\d+)/.exec(afterQty)?.[1]?.replace(/,/g, '')) || undefined
    const name: string[] = []
    for (let j = i + 1; j < Math.min(ls.length, i + 6); j++) {
      if (/(?:^|\s)\d{12,13}(?=\s)/.test(ls[j]) || /^total\b/i.test(ls[j])) break
      if (/[a-z]{3}/i.test(ls[j])) name.push(ls[j].replace(/^\d{6,}\s+[\d.,\s]*/, ''))
    }
    if (qty || nums.length >= 3) out.push({ ean: m[1].replace(/^0(?=\d{12}$)/, ''), qty, basic, text: name.join(' ').trim(), line: i })
  }
  return out
}

/** Atom Foods' own GSTIN appears on every PO: it is never the customer's. */
export const OWN_GSTINS = ['27ACAFA7039D1ZP']
