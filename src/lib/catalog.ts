// Products and their other names, loaded once and searched in the browser.
import { useCallback, useEffect, useState } from 'react'
import { features, norm, scoreProduct, tidy } from './match'
import { supabase } from './supabase'

export interface Product {
  sku: string
  name: string
  size: string | null
  mrp: number | null
  ee_type: string | null
  gst_rate: number
  hsn: string | null
  ean: string | null
  image_url: string | null
  tally_name: string | null
  tally_status: 'none' | 'suggested' | 'confirmed'
  is_offline: boolean
  is_retail: boolean
  replaced_by: string | null
  notes: string | null
  in_easy_ecom: boolean
  site_mrp: number | null      // price on atomeats.com at the last check
  site_checked_at: string | null
}

export interface Alias {
  id: number
  sku: string
  alias: string
  alias_norm: string
  kind: string
  status: 'suggested' | 'confirmed' | 'rejected'
  source: string | null
  times_seen: number
}

export const ALIAS_KINDS: Record<string, string> = {
  ee_name: 'Easy Ecom name',
  tally: 'Tally name',
  shopify: 'Shopify',
  amazon: 'Amazon',
  old_sku: 'Old SKU',
  ean: 'Barcode',
  customer_code: 'Customer item code',
  nickname: 'Nickname',
  retail_form: 'Old retail form',
}

/** Reads every row of a table, 1000 at a time (the database sends at most 1000 per request). */
export async function fetchAll<T>(table: string, select: string, build?: (q: any) => any): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(select).range(from, from + 999)
    if (build) q = build(q)
    const { data, error } = await q
    if (error) throw error
    out.push(...((data ?? []) as T[]))
    if (!data || data.length < 1000) return out
  }
}

export interface Catalog {
  products: Product[]
  bySku: Map<string, Product>
  aliases: Alias[]
  aliasesBySku: Map<string, Alias[]>
}

let cache: Catalog | null = null

export async function loadCatalog(force = false): Promise<Catalog> {
  if (cache && !force) return cache
  const [products, aliases] = await Promise.all([
    fetchAll<Product>('products', 'sku, name, size, mrp, ee_type, gst_rate, hsn, ean, image_url, tally_name, tally_status, is_offline, is_retail, replaced_by, notes, in_easy_ecom, site_mrp, site_checked_at', (q) => q.order('name')),
    fetchAll<Alias>('product_aliases', 'id, sku, alias, alias_norm, kind, status, source, times_seen', (q) => q.neq('status', 'rejected')),
  ])
  const aliasesBySku = new Map<string, Alias[]>()
  for (const a of aliases) aliasesBySku.set(a.sku, [...(aliasesBySku.get(a.sku) ?? []), a])
  cache = { products, bySku: new Map(products.map((p) => [p.sku, p])), aliases, aliasesBySku }
  return cache
}

export function useCatalog() {
  const [catalog, setCatalog] = useState<Catalog | null>(cache)
  const [error, setError] = useState('')
  const reload = useCallback(async (force = true) => {
    try {
      setCatalog(await loadCatalog(force))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => { if (!cache) reload(false) }, [reload])
  return { catalog, error, reload }
}

/** "Mini Pretzel Knots · 30 g · ₹99" */
export function productLabel(p: Product): string {
  const name = p.name.replace(/ - Pack of 1$/i, '')
  const sizeInName = p.size && features(name).grams === features(p.size).grams
  return [name, sizeInName ? null : p.size, p.mrp != null ? `₹${p.mrp}` : null].filter(Boolean).join(' · ')
}

/** Finds products for what someone typed: SKU, barcode, any other name, or a misspelt description. */
export function searchProducts(c: Catalog, query: string, opts: { offlineOnly?: boolean; limit?: number } = {}): Product[] {
  const q = query.trim()
  const limit = opts.limit ?? 30
  const pool = opts.offlineOnly ? c.products.filter((p) => p.is_offline) : c.products
  if (!q) return pool.slice(0, limit)
  const qn = norm(q)
  const qt = tidy(q)
  const qf = features(q)
  const scored = pool.map((p) => {
    let s = 0
    if (p.sku.toLowerCase() === q.toLowerCase() || p.ean === q.replace(/\D/g, '')) s = 10
    else if (norm(p.sku).includes(qn) && qn.length >= 3) s = 5
    const names = [`${p.name} ${p.size ?? ''}`, ...(c.aliasesBySku.get(p.sku) ?? []).map((a) => a.alias)]
    for (const n of names) {
      const nn = tidy(n)
      if (nn === qt) s = Math.max(s, 4)
      else if (nn.includes(qt) && qt.length >= 3) s = Math.max(s, 3)
      s = Math.max(s, scoreProduct(qf, { ...features(n), mrp: p.mrp }) * 2.5)
    }
    if (p.is_offline) s += 0.2
    return { p, s }
  })
  return scored.filter((x) => x.s >= 1.2).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.p)
}
