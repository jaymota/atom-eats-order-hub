// Downloads, steps 1 and 2: what Easy Ecom must know before the orders can go in.
// 1. New customers: the customer file, then Easy Ecom's Customer Master export brings their codes back.
// 2. New products: cost, weight and size (and for a combo, what's inside), then the product file and
//    the combo file. Step 3 (the orders) is the Downloads page itself.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { comboRows, customerMasterCodes, newCustomerRows, productGaps, productRows, toCsv, type EeOrder, type NewProduct } from '../lib/easyecom'
import { supabase } from '../lib/supabase'
import { ProductPicker } from '../pages/Checks'
import { Badge, Button, Card, ErrorBox, Input, OkBox } from './ui'

interface Row extends NewProduct { ee_type: string | null; site_combo: boolean; ee_product_done: boolean }
type Edit = { sku: string; cost: string; weight_g: string; length_cm: string; height_cm: string; width_cm: string; parts: { sku: string; qty: number }[] }

const str = (v: number | null) => (v == null ? '' : String(v))
const toEdit = (p: Row): Edit => ({ sku: p.sku.startsWith('CUSTOM-') ? '' : p.sku, cost: str(p.cost), weight_g: str(p.weight_g), length_cm: str(p.length_cm), height_cm: str(p.height_cm), width_cm: str(p.width_cm), parts: p.parts })
const isCombo = (p: Row) => p.ee_type === 'Combo' || p.site_combo || p.parts.length > 0

export default function EeSetup({ orders, eeSkus, day, save, onChange }: {
  orders: EeOrder[]; eeSkus: Set<string>; day: string; save: (name: string, data: string) => void; onChange: () => void
}) {
  const [rows, setRows] = useState<Row[]>([])
  const [edit, setEdit] = useState<Record<string, Edit>>({})
  const [adding, setAdding] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const waiting = useMemo(() => orders.filter((o) => !o.ee_uploaded_at), [orders])
  const customers = newCustomerRows(waiting).length - 1
  const custNames = [...new Set(waiting.filter((o) => o.customer && !o.customer.ee_customer_code).map((o) => o.customer_name))]
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
  const toCreate = rows.filter((p) => !p.ee_product_done)
  const combosLeft = rows.filter((p) => p.ee_product_done && p.parts.length)
  const ready = toCreate.length > 0 && toCreate.every((p) => !gaps(p).length)

  const run = async (fn: () => PromiseLike<{ data?: unknown; error: { message: string } | null }>, ok: (d: unknown) => string) => {
    setBusy(true); setError(''); setMsg('')
    const { data, error: e } = await fn()
    setBusy(false)
    if (e) { setError(e.message); return false }
    setMsg(ok(data)); await load(); onChange()
    return true
  }

  const saveRow = (p: Row) => {
    const e = edit[p.sku]
    return run(() => supabase.rpc('save_new_product', { p_sku: p.sku, p: { ...e, sku: e.sku || null } }), () => `Saved ${p.name}.`)
  }

  const readMaster = async (f: File) => {
    const X = await import('xlsx')
    const wb = X.read(await f.arrayBuffer(), { type: 'array', raw: false })
    const list = customerMasterCodes(X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }))
    if (!list.length) { setError('That file has no Customer_Code column. Use Easy Ecom → Masters → Customer Master → export.'); return }
    run(() => supabase.rpc('link_ee_customer_codes', { p_rows: list }), (n) => `${n} customer${n === 1 ? '' : 's'} linked to Easy Ecom.`)
  }

  if (!customers && !custNames.length && !rows.length) return null
  const setE = (sku: string, patch: Partial<Edit>) => setEdit({ ...edit, [sku]: { ...edit[sku], ...patch } })

  return (
    <div className="space-y-3">
      <OkBox>{msg}</OkBox>
      <ErrorBox>{error}</ErrorBox>

      {custNames.length > 0 && (
        <Card className="space-y-2">
          <h3 className="font-semibold text-ae-blue">1 · New customers ({custNames.length})</h3>
          <p className="text-sm text-stone-600">{custNames.join(' · ')}</p>
          <div className="flex flex-wrap gap-2">
            <Button tone="plain" disabled={!customers} onClick={() => save(`easyecom-new-customers-${day}.csv`, toCsv(newCustomerRows(waiting)))}>⬇ Customer file</Button>
            <label className={`inline-flex min-h-12 cursor-pointer items-center rounded-lg border border-stone-300 bg-white px-5 font-semibold text-stone-800 ${busy ? 'opacity-50' : ''}`}>
              ⬆ Customer Master
              <input type="file" accept=".csv,.xlsx,.xls" className="hidden" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) readMaster(f) }} />
            </label>
          </div>
        </Card>
      )}

      {rows.length > 0 && (
        <Card className="space-y-3">
          <h3 className="font-semibold text-ae-blue">2 · New products ({rows.length})</h3>
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
                      {!p.ee_product_done && <ProductPicker placeholder="Add a product inside…" onPick={(x) => x.sku !== p.sku && !e.parts.some((y) => y.sku === x.sku) && setE(p.sku, { parts: [...e.parts, { sku: x.sku, qty: 1 }] })} />}
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
          <div className="flex flex-wrap gap-2 border-t border-stone-100 pt-3">
            {toCreate.length > 0 && <>
              <Button tone="plain" disabled={!ready} onClick={() => save(`easyecom-new-products-${day}.csv`, toCsv(productRows(toCreate)))}>⬇ Product file ({toCreate.length})</Button>
              <Button disabled={!ready || busy} onClick={() => run(() => supabase.rpc('mark_in_easy_ecom', { p_skus: toCreate.map((p) => p.sku), p_step: 'products' }), () => 'Products marked as created in Easy Ecom.')}>✓ Products created</Button>
            </>}
            {combosLeft.length > 0 && <>
              <Button tone="plain" onClick={() => save(`easyecom-virtual-combos-${day}.csv`, toCsv(comboRows(combosLeft)))}>⬇ Virtual combo file ({combosLeft.length})</Button>
              <Button disabled={busy} onClick={() => run(() => supabase.rpc('mark_in_easy_ecom', { p_skus: combosLeft.map((p) => p.sku), p_step: 'combos' }), () => 'Combos marked as created in Easy Ecom.')}>✓ Combos created</Button>
            </>}
          </div>
          {toCreate.length > 0 && !ready && <p className="text-xs text-stone-500">Fill ✱ and Save each product first.</p>}
        </Card>
      )}
    </div>
  )
}
