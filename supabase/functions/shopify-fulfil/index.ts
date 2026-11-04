// Marks atomeats.com (Shopify) orders as fulfilled with their tracking number, from the Online orders
// page (one order, a tracking file, or label photos). Shopify then sends its usual "shipped" email.
// Needs the Dev Dashboard app to have write_merchant_managed_fulfillment_orders (and the third-party
// one if a fulfilment app holds the orders). Ops and admins only.
import { adminDb, cors, getCaller, json, logActivity, rateLimit } from '../_shared/server.ts'
import { shopifyRow, type ShopifyOrder } from '../_shared/shopify.ts'

const STORE = Deno.env.get('SHOPIFY_STORE') ?? '89afa3'
const API = '2026-07'
const BASE = `https://${STORE}.myshopify.com/admin`
// Names Shopify knows (it builds the tracking link itself); anything else is shown as typed.
const COMPANY: Record<string, string> = { DTDC: 'DTDC', 'Blue Dart': 'Bluedart', Delhivery: 'Delhivery', Porter: 'Porter' }

const ORDER = `query Order($id: ID!) {
  order(id: $id) {
    legacyResourceId name createdAt updatedAt cancelledAt displayFinancialStatus displayFulfillmentStatus
    currentTotalPriceSet { shopMoney { amount } }
    shippingAddress { name city }
    fulfillments(first: 5) { createdAt }
    lineItems(first: 25) { nodes { sku title variantTitle currentQuantity unfulfilledQuantity } }
    fulfillmentOrders(first: 10) { nodes { id status } }
  }
}`
const FULFIL = `mutation Fulfil($f: FulfillmentInput!) {
  fulfillmentCreate(fulfillment: $f) { fulfillment { id status } userErrors { field message } }
}`

type Item = { id: number; tracking: string; company: string }
type Result = { id: number; name?: string; ok: boolean; error?: string }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) })
  if (req.method !== 'POST') return json(req, { error: 'Not allowed' }, 405)
  const db = adminDb()
  const me = await getCaller(req, db)
  if (!me) return json(req, { error: 'Please log in again.' }, 401)
  if (!['super_admin', 'admin', 'manager', 'ops'].includes(me.role)) return json(req, { error: 'Only ops and admins can fulfil online orders.' }, 403)
  const id = Deno.env.get('SHOPIFY_CLIENT_ID'), secret = Deno.env.get('SHOPIFY_CLIENT_SECRET')
  if (!id || !secret) return json(req, { error: 'Shopify is not linked yet.' })
  if (!(await rateLimit(db, `shopify-fulfil:${me.id}`, 60, 60))) return json(req, { error: 'Too many in a short time. Please wait a few minutes.' }, 429)

  const { orders } = await req.json().catch(() => ({})) as { orders?: Item[] }
  const items = (orders ?? []).filter((o) => o && Number(o.id) > 0 && String(o.tracking ?? '').trim()).slice(0, 15)
  if (!items.length) return json(req, { error: 'Nothing to fulfil.' }, 400)

  const t = await fetch(`${BASE}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  })
  if (!t.ok) return json(req, { error: `Shopify didn't accept the Hub's app (${t.status}).` }, 502)
  const { access_token } = await t.json() as { access_token: string }
  const gql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const r = await fetch(`${BASE}/api/${API}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': access_token },
      body: JSON.stringify({ query, variables }),
    })
    const body = await r.json().catch(() => ({})) as { data?: T; errors?: { message: string }[] }
    if (!r.ok || body.errors?.length) {
      const msg = body.errors?.[0]?.message ?? `Shopify didn't answer (${r.status}).`
      throw new Error(/access denied|scope/i.test(msg) ? 'The Hub’s Shopify app doesn’t have permission to fulfil orders yet.' : msg)
    }
    return body.data as T
  }

  const results: Result[] = []
  for (const it of items) {
    const tracking = String(it.tracking).trim().toUpperCase()
    const company = COMPANY[it.company] ?? (String(it.company ?? '').trim() || 'DTDC')
    try {
      const { order } = await gql<{ order: (ShopifyOrder & { fulfillmentOrders: { nodes: { id: string; status: string }[] } }) | null }>(ORDER, { id: `gid://shopify/Order/${it.id}` })
      if (!order) { results.push({ id: it.id, ok: false, error: 'Not found in Shopify.' }); continue }
      if (order.cancelledAt) { results.push({ id: it.id, name: order.name, ok: false, error: 'Cancelled.' }); continue }
      const open = order.fulfillmentOrders.nodes.filter((f) => ['OPEN', 'IN_PROGRESS'].includes(f.status))
      if (!open.length) { results.push({ id: it.id, name: order.name, ok: false, error: 'Already fulfilled.' }); continue }
      // One fulfilment per fulfilment order (they can sit at different locations); Shopify emails the customer.
      for (const fo of open) {
        const { fulfillmentCreate: fc } = await gql<{ fulfillmentCreate: { userErrors: { message: string }[] } }>(FULFIL, {
          f: { notifyCustomer: true, trackingInfo: { number: tracking, company }, lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: fo.id }] },
        })
        if (fc.userErrors.length) throw new Error(fc.userErrors[0].message)
      }
      // Refresh the Hub's copy so the order moves to Shipped straight away.
      const { order: fresh } = await gql<{ order: ShopifyOrder }>(ORDER, { id: `gid://shopify/Order/${it.id}` })
      await db.from('shopify_orders').upsert({ ...shopifyRow(fresh), synced_at: new Date().toISOString() })
      await logActivity(db, me.id, 'shopify_fulfilled', `${me.name} fulfilled ${order.name} on Shopify: ${company} ${tracking}`, { entity_type: 'shopify_order', entity_id: String(it.id) })
      results.push({ id: it.id, name: order.name, ok: true })
    } catch (e) {
      results.push({ id: it.id, ok: false, error: (e as Error).message })
      if (/permission/i.test((e as Error).message)) break
    }
  }
  return json(req, { results })
})
