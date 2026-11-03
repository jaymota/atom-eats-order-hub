// Copies atomeats.com orders from Shopify into shopify_orders, every 15 minutes (GitHub Action) or from
// the Online orders page. Read-only on Shopify: it never changes anything there.
// Needs SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (a Dev Dashboard app on the store, read_orders).
// The first run brings in the last 60 days (all that read_orders allows); later runs only what changed.
import { adminDb, cors, json, rateLimit } from '../_shared/server.ts'
import { shopifyRow, type ShopifyOrder } from '../_shared/shopify.ts'

const STORE = Deno.env.get('SHOPIFY_STORE') ?? '89afa3' // atomeats.com's *.myshopify.com name
const API = '2026-07'
const BASE = `https://${STORE}.myshopify.com/admin`

const query = (withAddress: boolean) => `query Orders($after: String, $q: String) {
  orders(first: 20, after: $after, query: $q, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      legacyResourceId name createdAt updatedAt cancelledAt displayFinancialStatus displayFulfillmentStatus
      currentTotalPriceSet { shopMoney { amount } }
      ${withAddress ? 'shippingAddress { name city }' : ''}
      fulfillments(first: 5) { createdAt }
      lineItems(first: 25) { nodes { sku title variantTitle currentQuantity unfulfilledQuantity } }
    }
  }
}`

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) })
  if (req.method !== 'POST') return json(req, { error: 'Not allowed' }, 405)
  const id = Deno.env.get('SHOPIFY_CLIENT_ID'), secret = Deno.env.get('SHOPIFY_CLIENT_SECRET')
  if (!id || !secret) return json(req, { error: 'Shopify is not linked yet.' })
  const db = adminDb()
  if (!(await rateLimit(db, 'shopify-sync', 12, 60))) return json(req, { error: 'Checked a moment ago. Please try again in a few minutes.' }, 429)

  const t = await fetch(`${BASE}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  })
  if (!t.ok) return json(req, { error: `Shopify didn't accept the Hub's app (${t.status}).` }, 502)
  const { access_token } = await t.json() as { access_token: string }

  // From the newest change already here (a few minutes back, to be safe), else the last 60 days.
  const { data: last } = await db.from('shopify_orders').select('shopify_updated_at').order('shopify_updated_at', { ascending: false }).limit(1)
  const from = last?.[0] ? new Date(Date.parse(last[0].shopify_updated_at) - 10 * 60_000) : new Date(Date.now() - 60 * 864e5)
  const q = last?.[0] ? `updated_at:>='${from.toISOString()}'` : `created_at:>='${from.toISOString()}'`

  const started = Date.now()
  let after: string | null = null, withAddress = true, saved = 0
  while (Date.now() - started < 50_000) {
    const r = await fetch(`${BASE}/api/${API}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': access_token },
      body: JSON.stringify({ query: query(withAddress), variables: { after, q } }),
    })
    if (!r.ok) return json(req, { error: `Shopify didn't answer (${r.status}).`, saved }, 502)
    const { data, errors } = await r.json() as { data?: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: ShopifyOrder[] } }; errors?: { message: string; extensions?: { code?: string } }[] }
    if (errors?.length) {
      if (errors.some((e) => e.extensions?.code === 'THROTTLED')) break // the next run carries on
      // Names and cities need Shopify's "protected customer data" permission; carry on without them.
      if (withAddress && errors.some((e) => /shippingAddress|access denied|protected customer/i.test(e.message))) { withAddress = false; continue }
      return json(req, { error: errors[0].message, saved }, 502)
    }
    const page = data!.orders
    if (page.nodes.length) {
      const rows = page.nodes.map(shopifyRow).map((x) => ({ ...x, synced_at: new Date().toISOString() }))
      const { error } = await db.from('shopify_orders').upsert(rows)
      if (error) return json(req, { error: error.message, saved }, 500)
      saved += rows.length
    }
    if (!page.pageInfo.hasNextPage) break
    after = page.pageInfo.endCursor
  }
  return json(req, { ok: true, saved, names: withAddress })
})
