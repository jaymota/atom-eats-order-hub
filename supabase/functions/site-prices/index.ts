// Reads the public product list of atomeats.com every 6 hours (GitHub Action, or the "Check the website
// now" button) and:
//  - notes each product's website price (the higher of "price" and "compare at") for Checks → Prices;
//  - combos, gift boxes and variety packs: marks them orderable, keeps their MRP equal to the website's,
//    and adds new ones (website SKUs come from Easy Ecom through Shopify);
//  - marks products that left the website, so they drop out of the order forms (never deleted).
// Single products' MRPs are never changed here: an admin accepts those in Checks.
import { adminDb, cors, json, rateLimit } from '../_shared/server.ts'

const SHOP = 'https://atomeats.com'

interface Variant { sku: string | null; price: string; compare_at_price: string | null; title: string }
interface ShopProduct { title: string; product_type: string; tags: string[]; variants: Variant[]; images?: { src: string }[] }

/** Combos, gift boxes, hampers and variety packs (not gift wrap or gift cards). */
const isCombo = (p: ShopProduct) => !/gift ?wrap|gift ?card/i.test(p.title) && !p.tags?.includes('giftcard')
  && (/combo|box\b|hamper|bundle|variety|gift/i.test(p.title) || /combo|gift/i.test(p.product_type ?? ''))

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

  // A half-loaded website must never hide the whole range.
  if (shop.length < 20) return json(req, { error: `Only ${shop.length} products came back from atomeats.com; nothing changed.` }, 502)

  const { data: prods } = await db.from('products').select('sku, name, size, replaced_by, is_offline, mrp, site_combo, on_website, image_url')
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
  // Combos and boxes: orderable, MRP follows the website, new ones added.
  const live = new Set<string>()
  const comboSkus = new Set<string>()
  const added: string[] = []
  const repriced: string[] = []
  for (const sp of shop) {
    for (const v of sp.variants) {
      const sku = (v.sku ?? '').trim()
      if (!sku) continue
      live.add(sku)
      if (!isCombo(sp)) continue
      comboSkus.add(sku)
      const mrp = Math.max(Number(v.price) || 0, Number(v.compare_at_price) || 0) || null
      const name = v.title && !/default title/i.test(v.title) && !/pack of 1$/i.test(v.title) ? `${sp.title} - ${v.title}` : sp.title
      const p = bySku.get(sku)
      if (!p) {
        const { error } = await db.from('products').insert({ sku, name, mrp, gst_rate: 5, ee_type: 'Combo', in_easy_ecom: false, is_offline: false, // created in Easy Ecom from Downloads
          site_combo: true, on_website: true, site_mrp: mrp, site_sku: sku, site_checked_at: now, image_url: sp.images?.[0]?.src ?? null })
        if (!error) added.push(`${name} (${sku})`)
        continue
      }
      if (mrp && Number(p.mrp) !== mrp) repriced.push(`${p.name} (${sku}): MRP ₹${p.mrp ?? '—'} → ₹${mrp}`)
      await db.from('products').update({ site_combo: true, ...(mrp ? { mrp } : {}), ...(p.image_url ? {} : { image_url: sp.images?.[0]?.src ?? null }) }).eq('sku', sku)
    }
  }
  // On / off the website (only products the website ever showed are switched off).
  for (const p of list) {
    const on = live.has(p.sku)
    if (on !== p.on_website) await db.from('products').update({ on_website: on }).eq('sku', p.sku)
  }
  for (const a of added) await db.from('activity').insert({ kind: 'product_added', summary: `New on atomeats.com, added to the Hub: ${a}`, entity_type: 'product' })
  for (const r of repriced) await db.from('activity').insert({ kind: 'product_updated', summary: `Combo price follows atomeats.com: ${r}`, entity_type: 'product' })

  const rows = [...found].map(([sku, v]) => ({ sku, ...v, site_checked_at: now }))
  for (let i = 0; i < rows.length; i += 200) {
    for (const r of rows.slice(i, i + 200)) {
      await db.from('products').update({ site_mrp: r.site_mrp, site_sku: r.site_sku, site_checked_at: r.site_checked_at }).eq('sku', r.sku)
    }
  }
  return json(req, { ok: true, checked: rows.length, websiteProducts: shop.length, combos: comboSkus.size, added: added.length, repriced: repriced.length, at: now })
})
