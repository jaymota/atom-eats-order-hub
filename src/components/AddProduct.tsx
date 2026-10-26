// Add a product that isn't in the list: a custom item, a hamper, or a new product.
// Without an Easy Ecom SKU the Hub makes a temporary one (CUSTOM-0001) and flags it,
// because Easy Ecom must have the product before the evening upload.
import { useState } from 'react'
import { loadCatalog, type Product } from '../lib/catalog'
import { supabase } from '../lib/supabase'
import { Button, ErrorBox, Field, Input, Select } from './ui'

export default function AddProduct({ startName = '', onAdded, onCancel }: { startName?: string; onAdded: (p: Product) => void; onCancel: () => void }) {
  const [f, setF] = useState({ name: startName, size: '', mrp: '', gst_rate: '5', hsn: '', tally_name: '', sku: '', notes: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const save = async () => {
    setBusy(true)
    setError('')
    const { data, error: e } = await supabase.rpc('add_product', { p: f })
    if (e) { setError(e.message); setBusy(false); return }
    const cat = await loadCatalog(true)
    setBusy(false)
    const p = cat.bySku.get(data as string)
    if (p) onAdded(p)
  }
  return (
    <div className="space-y-3 rounded-lg border border-ae-blue/30 bg-ae-cream/50 p-3">
      <p className="text-sm font-semibold text-ae-blue">New product</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field label="Product name ✱"><Input value={f.name} onChange={set('name')} placeholder="e.g. Custom Diwali hamper – 6 snacks" /></Field></div>
        <Field label="Pack size"><Input value={f.size} onChange={set('size')} placeholder="e.g. 30 g, 1 kg, box of 6" /></Field>
        <Field label="MRP ✱ (₹, incl. GST)"><Input value={f.mrp} onChange={set('mrp')} inputMode="decimal" /></Field>
        <Field label="GST %">
          <Select value={f.gst_rate} onChange={set('gst_rate')}>{['0', '5', '12', '18'].map((g) => <option key={g} value={g}>{g}%</option>)}</Select>
        </Field>
        <Field label="HSN code"><Input value={f.hsn} onChange={set('hsn')} inputMode="numeric" /></Field>
        <Field label="Tally item name"><Input value={f.tally_name} onChange={set('tally_name')} /></Field>
        <Field label="Easy Ecom SKU" hint="If it’s already in Easy Ecom. Leave empty and the Hub makes a temporary code; create the product in Easy Ecom before the evening upload.">
          <Input value={f.sku} onChange={set('sku')} autoCapitalize="characters" />
        </Field>
      </div>
      <ErrorBox>{error}</ErrorBox>
      <div className="flex gap-2">
        <Button disabled={busy || !f.name.trim() || !f.mrp} onClick={save}>{busy ? 'Adding…' : 'Add product'}</Button>
        <Button tone="plain" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}
