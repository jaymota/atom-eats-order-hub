// Stock needs: single packs still to go out (open orders) and sent in the last 7 / 30 days, combos
// broken into what's inside them. Offline orders and atomeats.com (Shopify) orders; Amazon isn't here.
import { useEffect, useMemo, useState } from 'react'
import { Badge, Card, Input } from '../components/ui'
import { fetchAll } from '../lib/catalog'
import { OPEN_STAGES, needs, shopifyNeedOrders, type ComboPart, type Need, type NeedOrder, type ShopifyNeedRow } from '../lib/needs'
import { todayIST } from '../lib/stages'

interface Prod { sku: string; name: string; size: string | null }
type Src = 'all' | 'offline' | 'online'
const SOURCES: [Src, string][] = [['all', 'All'], ['offline', 'Offline'], ['online', 'Online']]

export default function Needs() {
  const [data, setData] = useState<{ offline: NeedOrder[]; online: NeedOrder[]; combo: ComboPart[] } | null>(null)
  const [src, setSrc] = useState<Src>('all')
  const [prods, setProds] = useState<Map<string, Prod>>(new Map())
  const [find, setFind] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const today = todayIST()
    const since = new Date(Date.parse(today) - 35 * 864e5).toISOString().slice(0, 10)
    Promise.all([
      fetchAll<NeedOrder>('orders', 'stage, order_date, dispatch_date, order_lines(sku, qty)',
        (q) => q.neq('stage', 'cancelled').or(`stage.in.(${OPEN_STAGES.join(',')}),dispatch_date.gte.${since},order_date.gte.${since}`)),
      fetchAll<ShopifyNeedRow>('shopify_orders', 'cancelled, order_date, sent_on, lines', (q) => q.gte('order_date', since)),
      fetchAll<ComboPart>('combo_items', 'combo_sku, component_sku, qty'),
      fetchAll<Prod>('products', 'sku, name, size'),
    ]).then(([o, s, c, p]) => {
      setProds(new Map(p.map((x) => [x.sku, x])))
      setData({ offline: o, online: shopifyNeedOrders(s), combo: c })
    }).catch((e) => setError(e.message))
  }, [])

  const rows = useMemo(() => data && needs(src === 'online' ? data.online : src === 'offline' ? data.offline : [...data.offline, ...data.online], data.combo, todayIST()), [data, src])

  const name = (sku: string) => prods.get(sku)?.name.replace(/ - Pack of 1$/i, '') ?? sku
  const list = useMemo(() => {
    const q = find.trim().toLowerCase()
    return (rows ?? []).filter((r) => !q || `${r.sku} ${name(r.sku)}`.toLowerCase().includes(q))
  }, [rows, find, prods]) // eslint-disable-line react-hooks/exhaustive-deps
  const sum = (k: keyof Omit<Need, 'sku'>) => list.reduce((s, r) => s + r[k], 0)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-bold text-ae-blue">Stock needs</h2>
        <Input className="min-h-10 max-w-56 text-sm" placeholder="Product" value={find} onChange={(e) => setFind(e.target.value)} />
      </div>
      <div className="flex items-center gap-3">
        <div className="inline-flex rounded-lg border border-stone-300 bg-white p-0.5 text-sm">
          {SOURCES.map(([k, label]) => (
            <button key={k} type="button" onClick={() => setSrc(k)} className={`rounded-md px-3 py-1.5 font-semibold ${src === k ? 'bg-ae-blue text-ae-cream' : 'text-stone-600'}`}>{label}</button>
          ))}
        </div>
        <span className="text-xs text-stone-500">Single packs</span>
      </div>
      {error && <Card><p className="text-red-700">{error}</p></Card>}
      {!rows ? <p className="text-sm text-stone-500">Loading…</p> : !list.length ? <Card><p className="text-stone-600">Nothing here.</p></Card> : (
        <Card className="overflow-x-auto p-0 sm:p-0">
          <table className="w-full text-sm">
            <thead className="bg-ae-cream/60 text-left text-xs text-stone-600">
              <tr>
                <th className="px-3 py-2 font-semibold">Product</th>
                <th className="px-3 py-2 text-right font-semibold">To go out</th>
                <th className="px-3 py-2 text-right font-semibold">Sent 7 days</th>
                <th className="px-3 py-2 text-right font-semibold">Sent 30 days</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {list.map((r) => (
                <tr key={r.sku}>
                  <td className="px-3 py-2">
                    <div className="font-medium text-stone-900">{name(r.sku)}{prods.get(r.sku)?.size && <span className="font-normal text-stone-500"> · {prods.get(r.sku)!.size}</span>}</div>
                    <div className="font-mono text-xs text-stone-500">{r.sku || 'No SKU'}{!prods.has(r.sku) && <> <Badge tone="amber">Unknown product</Badge></>}</div>
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${r.open ? 'font-bold text-ae-blue' : 'text-stone-400'}`}>{r.open}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.sent7}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.sent30}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-stone-200 font-semibold">
              <tr>
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right tabular-nums">{sum('open')}</td>
                <td className="px-3 py-2 text-right tabular-nums">{sum('sent7')}</td>
                <td className="px-3 py-2 text-right tabular-nums">{sum('sent30')}</td>
              </tr>
            </tfoot>
          </table>
        </Card>
      )}
    </div>
  )
}
