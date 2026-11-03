// General Trade order form, for Vinay on the road: store, area, GST (if any), products, margin, samples. Nothing else.
// It is saved as a "Sales order"; Tejashree / Zeeshan add the rest from "To confirm".
import { useMemo, useState } from 'react'
import { Button, Card, ErrorBox, Input } from './ui'
import CustomerSearch from './CustomerSearch'
import { useAuth } from '../lib/auth'
import { isBulk, orderable, productLabel, useCatalog, type Product } from '../lib/catalog'
import { norm } from '../lib/match'
import type { CustomerLite } from '../lib/resolve'
import { supabase } from '../lib/supabase'
import { todoChanged } from '../lib/todo'

export default function GtForm({ onBack, foc = false }: { onBack: () => void; foc?: boolean }) {
  const { me } = useAuth()
  const { catalog } = useCatalog()
  const [party, setParty] = useState<CustomerLite | null>(null)
  const [newName, setNewName] = useState('')
  const [area, setArea] = useState('')
  const [gstin, setGstin] = useState('')
  const [margin, setMargin] = useState('')
  const [qty, setQty] = useState<Record<string, number>>({})
  const [q, setQ] = useState('')
  const [bulk, setBulk] = useState(false)
  const [samples, setSamples] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState('')

  const products = useMemo(() => {
    const qn = norm(q)
    return (catalog?.products ?? [])
      .filter((p) => orderable(p) && !p.replaced_by && (bulk || !isBulk(p)) && (!qn || norm(`${p.name} ${p.size ?? ''} ${p.sku}`).includes(qn)))
      // Single packs first, then the website's combos and gift boxes.
      .sort((a, b) => Number(a.site_combo && !a.is_offline) - Number(b.site_combo && !b.is_offline) || a.name.localeCompare(b.name))
  }, [catalog, q, bulk])
  const picked = Object.entries(qty).filter(([, n]) => n > 0)
  const pick = (c: CustomerLite | null) => {
    setParty(c)
    setArea(c?.billing_city ?? '')
    setGstin(c?.gstin ?? '')
    setMargin(c?.default_margin != null ? String(c.default_margin) : '')
  }
  const name = party?.name ?? newName.trim()
  // Store, area, products and (not for FOC) margin are needed; GST and samples are optional.
  const need = !name ? 'Choose the store' : !area.trim() ? 'Add the area' : !picked.length ? 'Add products' : !foc && !margin.trim() ? 'Add the margin %' : ''
  const set = (sku: string, n: number) => setQty({ ...qty, [sku]: Math.max(0, Math.min(9999, n)) })

  const send = async () => {
    setBusy(true); setError('')
    const m = margin.trim() ? Number(margin) : null
    const { data: id, error: e } = await supabase.rpc('save_order', {
      p_id: null,
      p: {
        sales_order: true, channel: foc ? 'FOC' : 'General Trade', source: 'gt_form', ...(foc ? { payment_type: 'FOC', payment_terms: 'FOC' } : {}), salesperson_id: me?.id, customer_id: party?.id ?? '', customer_name: name,
        phone: party?.phone ?? '', billing_city: area.trim(), gstin, gst_status: gstin ? 'registered' : '', margin_pct: foc ? '' : m ?? '',
        notes: samples.trim() ? `Samples: ${samples.trim()}` : '',
        lines: picked.map(([sku, n]) => {
          const p = catalog!.bySku.get(sku)!
          if (foc) return { sku, qty: n, price_basis: 'foc' }
          return m != null && !isBulk(p) ? { sku, qty: n, price_basis: 'mrp_minus_margin', margin_pct: m } : { sku, qty: n }
        }),
      },
    })
    setBusy(false)
    if (e) { setError(e.message); return }
    const { data } = await supabase.from('orders').select('order_no').eq('id', id).single()
    setSent(data?.order_no ?? 'Sent')
    todoChanged()
  }

  if (sent) {
    return (
      <Card className="space-y-4 py-8 text-center">
        <div className="text-5xl">✅</div>
        <p className="text-lg font-semibold text-ae-blue">{sent} sent</p>
        <p className="text-sm text-stone-600">{name} · {picked.length} products</p>
        <Button className="w-full" onClick={() => { setSent(''); pick(null); setNewName(''); setQty({}); setSamples('') }}>New GT order</Button>
      </Card>
    )
  }
  if (!catalog) return <p className="text-sm text-stone-500">Loading products…</p>

  return (
    <div className="space-y-3 pb-28">
      <Card className="space-y-2">
        <h3 className="font-semibold text-ae-blue">Store</h3>
        {party ? (
          <div className="flex items-center justify-between gap-2 rounded-xl bg-ae-cream/60 px-3 py-2">
            <div><div className="font-semibold">{party.name}</div><div className="text-xs text-stone-500">{[party.code, party.billing_city].filter(Boolean).join(' · ')}</div></div>
            <button type="button" className="text-sm font-semibold text-ae-blue underline" onClick={() => pick(null)}>Change</button>
          </div>
        ) : (
          <>
            <CustomerSearch onPick={pick} />
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="…or new store name" />
          </>
        )}
        <Input value={area} onChange={(e) => setArea(e.target.value)} placeholder="Area" aria-label="Area" />
        <Input value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase().replace(/\s/g, ''))} maxLength={15} placeholder="GSTIN (if any)" aria-label="GSTIN" />
        {!foc && <Input inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value.replace(/[^\d.]/g, ''))} placeholder="Margin %" aria-label="Margin %" />}
      </Card>

      <Card className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-ae-blue">Products {picked.length > 0 && <span className="text-stone-400">({picked.length})</span>}</h3>
          <label className="flex items-center gap-2 text-sm text-stone-600"><input type="checkbox" className="h-5 w-5" checked={bulk} onChange={(e) => setBulk(e.target.checked)} /> Bulk packs</label>
        </div>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search product" />
        <ul className="divide-y divide-stone-100">
          {products.map((p: Product, i) => {
            const n = qty[p.sku] ?? 0
            const comboStart = p.site_combo && !p.is_offline && !(products[i - 1]?.site_combo && !products[i - 1]?.is_offline)
            return (
              <li key={p.sku} className={`py-2 ${n ? 'bg-ae-yellow/30' : ''}`}>
                {comboStart && <div className="mb-2 mt-2 text-xs font-bold uppercase tracking-wide text-ae-blue">Combos &amp; boxes</div>}
                <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1 text-sm font-semibold text-stone-900">{productLabel(p)}</div>
                <button type="button" aria-label="Less" className="h-11 w-11 rounded-lg border border-stone-300 bg-white text-xl font-bold" onClick={() => set(p.sku, n - 1)}>−</button>
                <input inputMode="numeric" aria-label={`Quantity of ${p.name}`} className="h-11 w-14 rounded-lg border border-stone-300 text-center text-base" value={n || ''}
                  placeholder="0" onFocus={(e) => e.target.select()} onChange={(e) => set(p.sku, Number(e.target.value.replace(/\D/g, '')) || 0)} />
                <button type="button" aria-label="More" className="h-11 w-11 rounded-lg bg-ae-blue text-xl font-bold text-ae-cream" onClick={() => set(p.sku, n + 1)}>+</button>
                </div>
              </li>
            )
          })}
        </ul>
      </Card>

      <Card><Input value={samples} onChange={(e) => setSamples(e.target.value)} placeholder="Samples given (optional)" aria-label="Samples" /></Card>
      <ErrorBox>{error}</ErrorBox>

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-stone-200 bg-white/95 px-4 py-3 shadow-lg">
        <div className="mx-auto flex max-w-xl gap-2">
          <Button tone="plain" onClick={onBack}>Back</Button>
          <Button className="flex-1" disabled={busy || !!need} onClick={send}>{busy ? 'Sending…' : need || `Send (${picked.length})`}</Button>
        </div>
      </div>
    </div>
  )
}
