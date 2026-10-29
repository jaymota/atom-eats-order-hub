// General Trade order form, for Vinay on the road: party, products, quantities. Nothing else.
// It is saved as a "Sales order"; Tejashree / Zeeshan add the rest from "To confirm".
import { useMemo, useState } from 'react'
import { Button, Card, ErrorBox, Input } from './ui'
import CustomerSearch from './CustomerSearch'
import { useAuth } from '../lib/auth'
import { isBulk, productLabel, useCatalog, type Product } from '../lib/catalog'
import { norm } from '../lib/match'
import type { CustomerLite } from '../lib/resolve'
import { supabase } from '../lib/supabase'
import { todoChanged } from '../lib/todo'

export default function GtForm({ onBack }: { onBack: () => void }) {
  const { me } = useAuth()
  const { catalog } = useCatalog()
  const [party, setParty] = useState<CustomerLite | null>(null)
  const [newName, setNewName] = useState('')
  const [phone, setPhone] = useState('')
  const [qty, setQty] = useState<Record<string, number>>({})
  const [q, setQ] = useState('')
  const [bulk, setBulk] = useState(false)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState('')

  const products = useMemo(() => {
    const qn = norm(q)
    return (catalog?.products ?? [])
      .filter((p) => p.is_offline && !p.replaced_by && (bulk || !isBulk(p)) && (!qn || norm(`${p.name} ${p.size ?? ''} ${p.sku}`).includes(qn)))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [catalog, q, bulk])
  const picked = Object.entries(qty).filter(([, n]) => n > 0)
  const name = party?.name ?? newName.trim()
  const set = (sku: string, n: number) => setQty({ ...qty, [sku]: Math.max(0, Math.min(9999, n)) })

  const send = async () => {
    setBusy(true); setError('')
    const margin = party?.default_margin ?? null
    const { data: id, error: e } = await supabase.rpc('save_order', {
      p_id: null,
      p: {
        sales_order: true, channel: 'General Trade', source: 'gt_form', salesperson_id: me?.id, customer_id: party?.id ?? '', customer_name: name,
        phone: phone.trim() || party?.phone || '', notes,
        lines: picked.map(([sku, n]) => {
          const p = catalog!.bySku.get(sku)!
          return margin != null && !isBulk(p) ? { sku, qty: n, price_basis: 'mrp_minus_margin', margin_pct: margin } : { sku, qty: n }
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
        <Button className="w-full" onClick={() => { setSent(''); setParty(null); setNewName(''); setPhone(''); setQty({}); setNotes('') }}>New GT order</Button>
      </Card>
    )
  }
  if (!catalog) return <p className="text-sm text-stone-500">Loading products…</p>

  return (
    <div className="space-y-3 pb-28">
      <Card className="space-y-2">
        <h3 className="font-semibold text-ae-blue">Party</h3>
        {party ? (
          <div className="flex items-center justify-between gap-2 rounded-xl bg-ae-cream/60 px-3 py-2">
            <div><div className="font-semibold">{party.name}</div><div className="text-xs text-stone-500">{[party.code, party.billing_city].filter(Boolean).join(' · ')}</div></div>
            <button type="button" className="text-sm font-semibold text-ae-blue underline" onClick={() => setParty(null)}>Change</button>
          </div>
        ) : (
          <>
            <CustomerSearch onPick={setParty} />
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="…or new party name" />
          </>
        )}
        <Input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone (optional)" />
      </Card>

      <Card className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-ae-blue">Products {picked.length > 0 && <span className="text-stone-400">({picked.length})</span>}</h3>
          <label className="flex items-center gap-2 text-sm text-stone-600"><input type="checkbox" className="h-5 w-5" checked={bulk} onChange={(e) => setBulk(e.target.checked)} /> Bulk packs</label>
        </div>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search product" />
        <ul className="divide-y divide-stone-100">
          {products.map((p: Product) => {
            const n = qty[p.sku] ?? 0
            return (
              <li key={p.sku} className={`flex items-center gap-2 py-2 ${n ? 'bg-ae-yellow/30' : ''}`}>
                <div className="min-w-0 flex-1 text-sm font-semibold text-stone-900">{productLabel(p)}</div>
                <button type="button" aria-label="Less" className="h-11 w-11 rounded-lg border border-stone-300 bg-white text-xl font-bold" onClick={() => set(p.sku, n - 1)}>−</button>
                <input inputMode="numeric" aria-label={`Quantity of ${p.name}`} className="h-11 w-14 rounded-lg border border-stone-300 text-center text-base" value={n || ''}
                  placeholder="0" onFocus={(e) => e.target.select()} onChange={(e) => set(p.sku, Number(e.target.value.replace(/\D/g, '')) || 0)} />
                <button type="button" aria-label="More" className="h-11 w-11 rounded-lg bg-ae-blue text-xl font-bold text-ae-cream" onClick={() => set(p.sku, n + 1)}>+</button>
              </li>
            )
          })}
        </ul>
      </Card>

      <Card><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Note (optional)" /></Card>
      <ErrorBox>{error}</ErrorBox>

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-stone-200 bg-white/95 px-4 py-3 shadow-lg">
        <div className="mx-auto flex max-w-xl gap-2">
          <Button tone="plain" onClick={onBack}>Back</Button>
          <Button className="flex-1" disabled={busy || !name || !picked.length} onClick={send}>{busy ? 'Sending…' : !name ? 'Choose the party' : !picked.length ? 'Add products' : `Send (${picked.length})`}</Button>
        </div>
      </div>
    </div>
  )
}
