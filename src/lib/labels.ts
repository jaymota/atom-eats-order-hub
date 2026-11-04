// Reading website (Shopify) shipping labels: the tracking number from the barcode or the printed text,
// and which unshipped order the label belongs to (the label's "Invoice No." is the Shopify order
// number; the customer name and city back it up). Plain functions, so they can be tested.

export interface OpenOrder { id: number; name: string; customer: string | null; city: string | null }

/** The tracking number: a barcode first (exact), else the printed number under it. */
export function trackingFrom(barcodes: string[], text: string): { tracking: string; from: 'barcode' | 'text' } | null {
  const bc = barcodes.map((b) => b.trim().toUpperCase()).find((b) => /^[0-9A-Z]{8,16}$/.test(b) && /\d{6}/.test(b) && !/^89\d{11}$/.test(b))
  if (bc) return { tracking: bc, from: 'barcode' }
  for (let t of text.toUpperCase().match(/[0-9A-Z]{9,15}/g) ?? []) {
    if ((t.match(/\d/g) ?? []).length < 8) continue
    if (/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z][0-9A-Z]$/.test(t)) continue // GSTIN
    if (/^(91|0)?[6-9]\d{9}$/.test(t)) continue // phone
    // Common misreads of DTDC numbers such as 7X123927475.
    if (/^[TI]X\d{9}$/.test(t)) t = `7${t.slice(1)}`
    else if (/^X\d{9}$/.test(t)) t = `7${t}`
    return { tracking: t, from: 'text' }
  }
  return null
}

const low = (s: string | null | undefined) => (s ?? '').toLowerCase()

/** Unshipped orders ranked by how well they fit the label's text. `sure` when one clearly wins. */
export function matchOrder(text: string, open: OpenOrder[]): { order: OpenOrder | null; sure: boolean } {
  const words = low(text)
  const scored = open.map((o) => {
    let s = 0
    if (new RegExp(`\\b${o.name.replace('#', '')}\\b`).test(text)) s += 10
    for (const part of low(o.customer).split(/\s+/).filter((p) => p.length > 2)) if (words.includes(part.slice(0, 5))) s += 3
    if (o.city && words.includes(low(o.city))) s += 2
    return { o, s }
  }).sort((a, b) => b.s - a.s)
  const [a, b] = scored
  if (!a || a.s < 3) return { order: null, sure: false }
  return { order: a.o, sure: a.s >= 8 && a.s - (b?.s ?? 0) >= 5 }
}
