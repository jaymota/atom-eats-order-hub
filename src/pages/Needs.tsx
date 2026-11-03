// Stock needs: single packs still to go out (open orders) and sent in the last 7 / 30 days, combos
// broken into what's inside them. Offline orders only (Shopify and Amazon go straight to Easy Ecom).
import { useEffect, useMemo, useState } from 'react'
import { Card, Input } from '../components/ui'
import { fetchAll } from '../lib/catalog'
import { OPEN_STAGES, needs, type ComboPart, type Need, type NeedOrder } from '../lib/needs'
import { todayIST } from '../lib/stages'

interface Prod { sku: string; name: string; size: string | null }

export default function Needs() {
  const [rows, setRows] = useState<Need[] | null>(null)
  const [prods, setProds] = useState<Map<string, Prod>>(new Map())
  const [find, setFind] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const today = todayIST()
    const since = new Date(Date.parse(today) - 35 * 864e5).toISOString().slice(0, 10)
    Promise.all([
      fetchAll<NeedOrder>('orders', 'stage, order_date, dispatch_date, order_lines(sku, qty)',
        (q) => q.neq('stage', 'cancelled').or(`stage.in.(${OPEN_STAGES.join(',')}),dispatch_date.gte.${since},order_date.gte.${since}`)),
      fetchAll<ComboPart>('combo_items', 'combo_sku, component_sku, qty'),
      fetchAll<Prod>('products', 'sku, name, size'),
    ]).then(([o, c, p]) => {
      setProds(new Map(p.map((x) => [x.sku, x])))
      setRows(needs(o, c, today))
    }).catch((e) => setError(e.message))
  }, [])

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
      <p className="text-xs text-stone-500">Single packs · offline orders only</p>
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
                    <div className="font-mono text-xs text-stone-500">{r.sku}</div>
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
