// Downloads: the day's Easy Ecom work as six fixed options, always in the same place.
// 1 new customers → Easy Ecom, 2 their codes back from Easy Ecom's Customer Master, 3 new products,
// 4 new virtual combos, 5 the final order upload (only when 1–4 left nothing behind), 6 only the orders
// that are ready. Below: the details new products need (cost, size, and for a combo what's inside).
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { comboRows, customerMasterCodes, newCustomerRows, productGaps, productRows, toCsv, type EeOrder, type NewProduct } from '../lib/easyecom'
import { supabase } from '../lib/supabase'
import { ProductPicker } from '../pages/Checks'
import { Badge, Button, Card, ErrorBox, Input, OkBox } from './ui'

interface Row extends NewProduct { ee_type: string | null; site_combo: boolean; ee_product_done: boolean }
type Edit = { sku: string; cost: string; weight_g: string; length_cm: string; height_cm: string; width_cm: string; parts: { sku: string; qty: number }[] }

const str = (v: number | null) => (v == null ? '' : String(v))
const toEdit = (p: Row): Edit => ({ sku: p.sku.startsWith('CUSTOM-') ? '' : p.sku, cost: str(p.cost), weight_g: str(p.weight_g), length_cm: str(p.length_cm), height_cm: str(p.height_cm), width_cm: str(p.width_cm), parts: p.parts })
const isCombo = (p: Row) => p.ee_type === 'Combo' || p.site_combo || p.parts.length > 0

function Option({ n, children, done }: { n: number; children: ReactNode; done?: ReactNode }) {
  return (
    <li className="flex items-center gap-3 py-2">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ae-blue text-sm font-bold text-ae-cream">{n}</span>
      <div className="min-w-0 flex-1">{children}</div>
      {done}
    </li>
  )
}

export default function EeSetup({ orders, eeSkus, day, save, onChange, ready, total, onOrders }: {
  orders: EeOrder[]; eeSkus: Set<string>; day: string; save: (name: string, data: string) => void; onChange: () => void
  ready: number; total: number; onOrders: () => void
}) {
  const [rows, setRows] = useState<Row[]>([])
  const [edit, setEdit] = useState<Record<string, Edit>>({})
  const [adding, setAdding] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const waiting = useMemo(() => orders.filter((o) => !o.ee_uploaded_at), [orders])
  const customers = newCustomerRows(waiting).length - 1
  const skus = useMemo(() => [...new Set(waiting.flatMap((o) => o.order_lines.map((l) => l.sku)).filter((s) => !eeSkus.has(s)))].sort(), [waiting, eeSkus])

  const load = useCallback(async () => {
    if (!skus.length) { setRows([]); return }
    const [p, c] = await Promise.all([
      supabase.from('products').select('sku, name, mrp, size, gst_rate, image_url, cost, weight_g, length_cm, height_cm, width_cm, ee_type, site_combo, ee_product_done').in('sku', skus),
      supabase.from('combo_items').select('combo_sku, component_sku, qty').in('combo_sku', skus),
    ])
    const parts = new Map<string, { sku: string; qty: number }[]>()
    for (const x of c.data ?? []) parts.set(x.combo_sku, [...(parts.get(x.combo_sku) ?? []), { sku: x.component_sku, qty: x.qty }])
    const r = ((p.data ?? []) as Omit<Row, 'parts'>[]).map((x) => ({ ...x, parts: parts.get(x.sku) ?? [] }))
    setRows(r)
    setEdit(Object.fromEntries(r.map((x) => [x.sku, toEdit(x)])))
  }, [skus])
  useEffect(() => { load() }, [load])

  const gaps = (p: Row) => [...productGaps(p), ...(isCombo(p) && !p.parts.length ? ['Inside'] : [])]
  const products = rows.filter((p) => !p.ee_product_done)
  const combos = rows.filter((p) => p.ee_product_done && p.parts.length)
  const productsReady = products.length > 0 && products.every((p) => !gaps(p).length)

  const run = async (fn: () => PromiseLike<{ data?: unknown; error: { message: string } | null }>, ok: (d: unknown) => string) => {
    setBusy(true); setError(''); setMsg('')
    const { data, error: e } = await fn()
    setBusy(false)
    if (e) { setError(e.message); return }
    setMsg(ok(data)); await load(); onChange()
  }
  const saveRow = (p: Row) => {
    const e = edit[p.sku]
    run(() => supabase.rpc('save_new_product', { p_sku: p.sku, p: { ...e, sku: e.sku || null } }), () => `Saved ${p.name}.`)
  }
  const readMaster = async (f: File) => {
    const X = await import('xlsx')
    const wb = X.read(await f.arrayBuffer(), { type: 'array', raw: false })
    const list = customerMasterCodes(X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }))
    if (!list.length) { setError('That file has no Customer_Code column. Use Easy Ecom → Masters → Customer Master → export.'); return }
    run(() => supabase.rpc('link_ee_customer_codes', { p_rows: list }), (n) => `${n} customer${n === 1 ? '' : 's'} linked to Easy Ecom.`)
  }
  const setE = (sku: string, patch: Partial<Edit>) => setEdit({ ...edit, [sku]: { ...edit[sku], ...patch } })
  const doneBtn = (on: boolean, fn: () => void) => <Button tone="plain" className="min-h-10 shrink-0 px-3 text-sm" disabled={!on || busy} onClick={fn}>✓ Done</Button>
  const btn = 'w-full justify-start text-left'

  return (
    <div className="space-y-3">
      <Card className="p-3 sm:p-4">
        <ol className="divide-y divide-stone-100">
          <Option n={1}>
            <Button tone="plain" className={btn} disabled={!customers} onClick={() => save(`easyecom-new-customers-${day}.csv`, toCsv(newCustomerRows(waiting)))}>⬇ New customers → Easy Ecom ({customers})</Button>
          </Option>
          <Option n={2}>
            <label className={`flex min-h-12 w-full cursor-pointer items-center rounded-lg border border-stone-300 bg-white px-5 font-semibold text-stone-800 hover:bg-ae-cream/50 ${busy ? 'opacity-50' : ''}`}>
              ⬆ Customers from Easy Ecom → Hub
              <input type="file" accept=".csv,.xlsx,.xls" className="hidden" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) readMaster(f) }} />
            </label>
          </Option>
          <Option n={3} done={doneBtn(productsReady, () => run(() => supabase.rpc('mark_in_easy_ecom', { p_skus: products.map((p) => p.sku), p_step: 'products' }), () => 'New products are in Easy Ecom.'))}>
            <Button tone="plain" className={btn} disabled={!productsReady} onClick={() => save(`easyecom-new-products-${day}.csv`, toCsv(productRows(products)))}>⬇ New products → Easy Ecom ({products.length})</Button>
          </Option>
          <Option n={4} done={doneBtn(combos.length > 0, () => run(() => supabase.rpc('mark_in_easy_ecom', { p_skus: combos.map((p) => p.sku), p_step: 'combos' }), () => 'New virtual combos are in Easy Ecom.'))}>
            <Button tone="plain" className={btn} disabled={!combos.length} onClick={() => save(`easyecom-virtual-combos-${day}.csv`, toCsv(comboRows(combos)))}>⬇ New virtual combos → Easy Ecom ({combos.length})</Button>
          </Option>
          <Option n={5}>
            <Button className={btn} disabled={!total || ready < total} onClick={onOrders}>⬇ Final upload ({total})</Button>
          </Option>
          <Option n={6}>
            <Button tone="plain" className={btn} disabled={!ready} onClick={onOrders}>⬇ Ready orders only ({ready})</Button>
          </Option>
        </ol>
      </Card>

      <OkBox>{msg}</OkBox>
      <ErrorBox>{error}</ErrorBox>

      {rows.length > 0 && (
        <Card className="space-y-3">
          <h3 className="font-semibold text-ae-blue">New products</h3>
          <ul className="space-y-3">
            {rows.map((p) => {
              const e = edit[p.sku]
              if (!e) return null
              const g = gaps(p)
              const combo = isCombo(p)
              return (
                <li key={p.sku} className="space-y-2 rounded-lg border border-stone-200 p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold text-stone-900">{p.name}</span>
                    <span className="font-mono text-xs text-stone-500">{p.sku}</span>
                    {combo && <Badge>Combo</Badge>}
                    {p.ee_product_done ? <Badge tone="green">Product done</Badge> : g.length > 0 && <Badge tone="amber">Needs {g.join(', ')}</Badge>}
                    <span className="text-sm text-stone-600">MRP ₹{p.mrp ?? '—'}</span>
                  </div>
                  {!p.ee_product_done && (
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                      {p.sku.startsWith('CUSTOM-') && <Input className="col-span-3 min-h-10 text-sm sm:col-span-2" placeholder="Easy Ecom SKU ✱" value={e.sku} onChange={(x) => setE(p.sku, { sku: x.target.value.toUpperCase() })} />}
                      <Input className="min-h-10 text-sm" inputMode="decimal" placeholder="Cost ✱" value={e.cost} onChange={(x) => setE(p.sku, { cost: x.target.value })} />
                      <Input className="min-h-10 text-sm" inputMode="decimal" placeholder="Grams" value={e.weight_g} onChange={(x) => setE(p.sku, { weight_g: x.target.value })} />
                      <Input className="min-h-10 text-sm" inputMode="decimal" placeholder="L cm" value={e.length_cm} onChange={(x) => setE(p.sku, { length_cm: x.target.value })} />
                      <Input className="min-h-10 text-sm" inputMode="decimal" placeholder="H cm" value={e.height_cm} onChange={(x) => setE(p.sku, { height_cm: x.target.value })} />
                      <Input className="min-h-10 text-sm" inputMode="decimal" placeholder="W cm" value={e.width_cm} onChange={(x) => setE(p.sku, { width_cm: x.target.value })} />
                    </div>
                  )}
                  {(combo || adding === p.sku) && (
                    <div className="space-y-1">
                      <div className="text-sm font-semibold text-stone-700">Inside</div>
                      {e.parts.map((c, i) => (
                        <div key={c.sku} className="flex items-center gap-2 text-sm">
                          <span className="font-mono">{c.sku}</span>
                          <Input className="min-h-9 w-16 text-sm" inputMode="numeric" value={c.qty} disabled={p.ee_product_done}
                            onChange={(x) => setE(p.sku, { parts: e.parts.map((y, j) => (j === i ? { ...y, qty: Math.max(1, Number(x.target.value) || 1) } : y)) })} />
                          {!p.ee_product_done && <button type="button" className="text-xs text-stone-500 underline" onClick={() => setE(p.sku, { parts: e.parts.filter((_, j) => j !== i) })}>Remove</button>}
                        </div>
                      ))}
                      {!p.ee_product_done && <ProductPicker placeholder="Add a product inside…" autoFocus={false} onPick={(x) => x.sku !== p.sku && !e.parts.some((y) => y.sku === x.sku) && setE(p.sku, { parts: [...e.parts, { sku: x.sku, qty: 1 }] })} />}
                    </div>
                  )}
                  {!p.ee_product_done && (
                    <div className="flex flex-wrap items-center gap-3">
                      <Button tone="plain" className="min-h-10 px-3 text-sm" disabled={busy} onClick={() => saveRow(p)}>Save</Button>
                      {!combo && adding !== p.sku && <button type="button" className="text-sm text-stone-500 underline" onClick={() => setAdding(p.sku)}>It's a combo / pack</button>}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </Card>
      )}
    </div>
  )
}
