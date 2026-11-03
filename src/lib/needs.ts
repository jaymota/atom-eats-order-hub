// Stock needs: every order line broken down into single packs (a combo, gift box or pack of 3
// becomes what's inside it, from combo_items, which follow Easy Ecom's Virtual Combo list).
// "To go out" = orders not dispatched yet; "Sent" = dispatched in the last 7 / 30 days.

export interface NeedOrder { stage: string; order_date: string; dispatch_date: string | null; order_lines: { sku: string; qty: number }[] }
export interface ComboPart { combo_sku: string; component_sku: string; qty: number }
export interface Need { sku: string; open: number; sent7: number; sent30: number }

export const OPEN_STAGES = ['sales_order', 'new', 'planned', 'invoiced', 'on_hold']
const SENT_STAGES = ['dispatched', 'delivered']

/** Adds qty of a SKU to `out`, broken into single packs (combos inside combos too, a few levels deep). */
export function explode(sku: string, qty: number, parts: Map<string, ComboPart[]>, out: Map<string, number>, depth = 0) {
  const inside = parts.get(sku)
  if (!inside?.length || depth > 3) { out.set(sku, (out.get(sku) ?? 0) + qty); return }
  for (const c of inside) explode(c.component_sku, qty * c.qty, parts, out, depth + 1)
}

/** `today` is YYYY-MM-DD (India time). */
export function needs(orders: NeedOrder[], combo: ComboPart[], today: string): Need[] {
  const parts = new Map<string, ComboPart[]>()
  for (const c of combo) parts.set(c.combo_sku, [...(parts.get(c.combo_sku) ?? []), c])
  const day = (n: number) => new Date(Date.parse(today) - n * 864e5).toISOString().slice(0, 10)
  const d7 = day(6), d30 = day(29) // today counts as one of the days
  const open = new Map<string, number>(), s7 = new Map<string, number>(), s30 = new Map<string, number>()
  for (const o of orders) {
    const isOpen = OPEN_STAGES.includes(o.stage)
    const sentOn = SENT_STAGES.includes(o.stage) ? (o.dispatch_date ?? o.order_date) : null
    for (const l of o.order_lines) {
      if (isOpen) explode(l.sku, l.qty, parts, open)
      if (sentOn && sentOn >= d30) explode(l.sku, l.qty, parts, s30)
      if (sentOn && sentOn >= d7) explode(l.sku, l.qty, parts, s7)
    }
  }
  return [...new Set([...open.keys(), ...s30.keys()])]
    .map((sku) => ({ sku, open: open.get(sku) ?? 0, sent7: s7.get(sku) ?? 0, sent30: s30.get(sku) ?? 0 }))
    .sort((a, b) => b.open - a.open || b.sent7 - a.sent7 || b.sent30 - a.sent30 || a.sku.localeCompare(b.sku))
}

/** Shopify (online) orders in the same shape: what's not shipped yet is open, the rest was sent. */
export interface ShopifyNeedRow { cancelled: boolean; order_date: string; sent_on: string | null; lines: { sku: string; qty: number; open: number }[] }
export function shopifyNeedOrders(rows: ShopifyNeedRow[]): NeedOrder[] {
  const out: NeedOrder[] = []
  for (const r of rows) {
    if (r.cancelled) continue
    const open = r.lines.filter((l) => l.open > 0).map((l) => ({ sku: l.sku, qty: l.open }))
    const sent = r.lines.filter((l) => l.qty > l.open).map((l) => ({ sku: l.sku, qty: l.qty - l.open }))
    if (open.length) out.push({ stage: 'new', order_date: r.order_date, dispatch_date: null, order_lines: open })
    if (sent.length) out.push({ stage: 'dispatched', order_date: r.order_date, dispatch_date: r.sent_on, order_lines: sent })
  }
  return out
}
