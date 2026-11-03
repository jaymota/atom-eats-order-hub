// Turns one Shopify order (Admin GraphQL) into a shopify_orders row. Used by the shopify-sync
// function, so it has no imports.

export interface ShopifyOrder {
  legacyResourceId: string
  name: string
  createdAt: string
  updatedAt: string
  cancelledAt: string | null
  displayFinancialStatus: string | null
  displayFulfillmentStatus: string | null
  currentTotalPriceSet: { shopMoney: { amount: string } } | null
  shippingAddress?: { name: string | null; city: string | null } | null
  fulfillments: { createdAt: string }[]
  lineItems: { nodes: { sku: string | null; title: string; variantTitle: string | null; currentQuantity: number; unfulfilledQuantity: number }[] }
}

export interface ShopifyLine { sku: string; title: string; qty: number; open: number }

/** YYYY-MM-DD in India time. */
export const istDate = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10)

export function shopifyRow(o: ShopifyOrder) {
  const lines: ShopifyLine[] = []
  for (const l of o.lineItems.nodes) {
    if (l.currentQuantity <= 0) continue // removed or fully refunded
    const title = l.variantTitle && !/default title/i.test(l.variantTitle) ? `${l.title} - ${l.variantTitle}` : l.title
    lines.push({ sku: (l.sku ?? '').trim(), title, qty: l.currentQuantity, open: Math.min(l.unfulfilledQuantity, l.currentQuantity) })
  }
  const first = o.fulfillments.map((f) => f.createdAt).sort()[0]
  return {
    id: Number(o.legacyResourceId),
    name: o.name,
    ordered_at: o.createdAt,
    order_date: istDate(o.createdAt),
    customer: o.shippingAddress?.name ?? null,
    city: o.shippingAddress?.city ?? null,
    total: Number(o.currentTotalPriceSet?.shopMoney.amount ?? 0),
    paid: o.displayFinancialStatus,
    shipped: o.displayFulfillmentStatus,
    cancelled: !!o.cancelledAt,
    sent_on: first ? istDate(first) : null,
    lines,
    shopify_updated_at: o.updatedAt,
  }
}
