// Reads the public product list of atomeats.com and notes each product's current price
// (the higher of "price" and "compare at"), so admins can see where the Hub's MRP differs.
// Called by a GitHub Action every few hours, and by the "Check the website now" button.
// It only reads a public website and never changes an MRP by itself.
import { adminDb, cors, json, rateLimit } from '../_shared/server.ts'

const SHOP = 'https://atomeats.com'

interface Variant { sku: string | null; price: string; compare_at_price: string | null; title: string }
interface ShopProduct { title: string; variants: Variant[] }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) })
  if (req.method !== 'POST') return json(req, { error: 'Not allowed' }, 405)
  const db = adminDb()
  if (!(await rateLimit(db, 'site-prices', 12, 60))) return json(req, { error: 'Checked a moment ago. Please try again in a few minutes.' }, 429)

  const shop: ShopProduct[] = []
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${SHOP}/products.json?limit=250&page=${page}`, { headers: { 'User-Agent': 'AtomEatsOrderHub/1.0' } })
    if (!res.ok) return json(req, { error: `atomeats.com didn't answer (${res.status}).` }, 502)
    const { products } = await res.json() as { products: ShopProduct[] }
    shop.push(...products)
    if (products.length < 250) break
  }

  const { data: prods } = await db.from('products').select('sku, name, size, replaced_by, is_offline')
  const list = prods ?? []
  const bySku = new Map(list.map((p) => [p.sku, p]))
  const key = (p: { name: string; size: string | null }) => `${norm(p.name)}|${p.size ?? ''}`
  const byKey = new Map<string, string[]>()
  for (const p of list) byKey.set(key(p), [...(byKey.get(key(p)) ?? []), p.sku])

  const now = new Date().toISOString()
  const found = new Map<string, { site_mrp: number; site_sku: string }>()
  for (const sp of shop) {
    for (const v of sp.variants) {
      const sku = (v.sku ?? '').trim()
      const p = bySku.get(sku)
      if (!p) continue
      const mrp = Math.max(Number(v.price) || 0, Number(v.compare_at_price) || 0)
      if (!mrp) continue
      // The same pack under its other Easy Ecom SKUs (e.g. Shopify's SKB01 and the offline SKB00).
      const same = new Set([sku, ...(byKey.get(key(p)) ?? [])])
      if (p.replaced_by) same.add(p.replaced_by)
      for (const s of same) if (!found.has(s) || s === sku) found.set(s, { site_mrp: mrp, site_sku: sku })
    }
  }
  const rows = [...found].map(([sku, v]) => ({ sku, ...v, site_checked_at: now }))
  for (let i = 0; i < rows.length; i += 200) {
    for (const r of rows.slice(i, i + 200)) {
      await db.from('products').update({ site_mrp: r.site_mrp, site_sku: r.site_sku, site_checked_at: r.site_checked_at }).eq('sku', r.sku)
    }
  }
  return json(req, { ok: true, checked: rows.length, websiteProducts: shop.length, at: now })
})
