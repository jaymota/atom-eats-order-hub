// Product list. Easy Ecom SKUs are the master codes; everything else is "other names".
import { useEffect, useMemo, useState } from 'react'
import AddProduct from '../components/AddProduct'
import { Badge, Button, Card, ErrorBox, Field, Input, Select } from '../components/ui'
import { useAuth } from '../lib/auth'
import { ALIAS_KINDS, productLabel, searchProducts, useCatalog, type Product } from '../lib/catalog'
import { ago, isAdmin } from '../lib/format'
import { supabase } from '../lib/supabase'

type Filter = 'offline' | 'retail' | 'all'

export function TallyBadge({ p }: { p: Product }) {
  if (p.tally_status === 'confirmed') return <Badge tone="green">Tally ✓</Badge>
  if (p.tally_status === 'suggested') return <Badge tone="amber">Tally: check</Badge>
  return <Badge tone="red">No Tally name</Badge>
}

function ProductDetail({ p, onClose, onSaved }: { p: Product; onClose: () => void; onSaved: () => void }) {
  const { me } = useAuth()
  const { catalog } = useCatalog()
  const admin = isAdmin(me?.role)
  const canTally = admin || me?.role === 'accounts'
  const [tally, setTally] = useState(p.tally_name ?? '')
  const [size, setSize] = useState(p.size ?? '')
  const [name, setName] = useState(p.name)
  const [mrp, setMrp] = useState(p.mrp != null ? String(p.mrp) : '')
  const [gst, setGst] = useState(String(p.gst_rate))
  const [hsn, setHsn] = useState(p.hsn ?? '')
  const [ean, setEan] = useState(p.ean ?? '')
  const [nick, setNick] = useState('')
  const [combo, setCombo] = useState<{ component_sku: string; qty: number }[]>([])
  const [tallyNames, setTallyNames] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    supabase.from('combo_items').select('component_sku, qty').eq('combo_sku', p.sku).then(({ data }) => setCombo(data ?? []))
    if (canTally) supabase.from('tally_items').select('name').order('name').limit(1000).then(({ data }) => setTallyNames((data ?? []).map((r) => r.name)))
  }, [p.sku, canTally])

  const run = async (fn: () => Promise<{ error: { message: string } | null }>) => {
    setBusy(true)
    setError('')
    const { error: e } = await fn()
    setBusy(false)
    if (e) setError(e.message)
    else onSaved()
  }

  const aliases = (catalog?.aliasesBySku.get(p.sku) ?? []).filter((a) => a.kind !== 'ee_name')
  const replaced = p.replaced_by ? catalog?.bySku.get(p.replaced_by) : null

  return (
    <Card className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-lg font-bold text-ae-blue">{p.name}</div>
          <div className="text-sm text-stone-600">Easy Ecom SKU <span className="font-mono font-semibold">{p.sku}</span> · {p.size ?? 'size not set'} · MRP ₹{p.mrp ?? '—'} · GST {p.gst_rate}%</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {p.is_offline ? <Badge tone="green">Used for offline orders</Badge> : <Badge>Not an offline SKU</Badge>}
            {p.is_retail && <Badge tone="amber">Retail</Badge>}
            {p.ee_type === 'Combo' && <Badge>Combo</Badge>}
            {!p.in_easy_ecom && <Badge tone="red">Not in Easy Ecom yet</Badge>}
            <TallyBadge p={p} />
          </div>
        </div>
        <Button tone="plain" className="min-h-10 px-3 text-sm" onClick={onClose}>Close</Button>
      </div>

      {!p.in_easy_ecom && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          This product was added in the Hub. Create it in Easy Ecom before the evening upload{p.sku.startsWith('CUSTOM-') ? ', then put the new Easy Ecom SKU in “Use instead” below so orders go across with the right code' : ''}.
        </p>
      )}
      {p.site_mrp != null && (
        <p className={`rounded-lg px-3 py-2 text-sm ${p.site_mrp !== p.mrp ? 'bg-amber-50 text-amber-900' : 'bg-green-50 text-green-800'}`}>
          atomeats.com: ₹{p.site_mrp}{p.site_checked_at && ` (checked ${ago(p.site_checked_at)})`}.{' '}
          {p.site_mrp !== p.mrp ? <>The Hub has ₹{p.mrp ?? '—'}.{admin && <> <button type="button" className="font-semibold underline" onClick={() => run(async () => supabase.rpc('accept_site_prices', { p_skus: [p.sku] }))}>Use the website price</button></>}</> : 'Same as the Hub.'}
        </p>
      )}

      {replaced && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Old SKU. For offline orders use <b className="font-mono">{replaced.sku}</b> ({productLabel(replaced)}).
        </p>
      )}

      <Field label="Tally item name" hint={p.tally_status === 'suggested' ? 'Suggested by the import. Check it and press Confirm.' : 'Accounts see this name on every order.'}>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input value={tally} onChange={(e) => setTally(e.target.value)} disabled={!canTally} list="tally-names" />
          {canTally && (
            <Button disabled={busy} onClick={() => run(async () => supabase.rpc('set_tally_name', { p_sku: p.sku, p_name: tally }))}>
              {p.tally_status === 'suggested' && tally === p.tally_name ? 'Confirm' : 'Save'}
            </Button>
          )}
        </div>
        <datalist id="tally-names">{tallyNames.map((n) => <option key={n} value={n} />)}</datalist>
      </Field>

      {admin && (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-3"><Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field></div>
          <Field label="MRP (₹, incl. GST)" hint="Used for “MRP minus margin” on every new order."><Input value={mrp} onChange={(e) => setMrp(e.target.value)} inputMode="decimal" /></Field>
          <Field label="Pack size"><Input value={size} onChange={(e) => setSize(e.target.value)} placeholder="e.g. 30 g" /></Field>
          <Field label="GST %">
            <Select value={gst} onChange={(e) => setGst(e.target.value)}>{['0', '5', '12', '18'].map((g) => <option key={g} value={g}>{g}%</option>)}</Select>
          </Field>
          <Field label="HSN code"><Input value={hsn} onChange={(e) => setHsn(e.target.value)} inputMode="numeric" /></Field>
          <Field label="Barcode (EAN)"><Input value={ean} onChange={(e) => setEan(e.target.value)} inputMode="numeric" /></Field>
          <Field label="Use instead (Easy Ecom SKU)" hint="For an old or temporary code."><Input defaultValue={p.replaced_by ?? ''} onBlur={(e) => e.target.value !== (p.replaced_by ?? '') && run(async () => supabase.rpc('save_product', { p_sku: p.sku, p: { replaced_by: e.target.value } }))} /></Field>
          <div className="flex flex-wrap gap-2 sm:col-span-3">
            <Button disabled={busy} onClick={() => run(async () => supabase.rpc('save_product', { p_sku: p.sku, p: { name, mrp, size, gst_rate: gst, hsn, ean } }))}>Save changes</Button>
            <Button tone="plain" disabled={busy} onClick={() => run(async () => supabase.rpc('save_product', { p_sku: p.sku, p: { is_offline: !p.is_offline } }))}>
              {p.is_offline ? 'Not used for offline orders' : 'Use for offline orders'}
            </Button>
            <Button tone="plain" disabled={busy} onClick={() => run(async () => supabase.rpc('save_product', { p_sku: p.sku, p: { is_retail: !p.is_retail } }))}>
              {p.is_retail ? 'Remove retail mark' : 'Mark as retail'}
            </Button>
            {!p.in_easy_ecom && (
              <Button tone="plain" disabled={busy} onClick={() => run(async () => supabase.rpc('save_product', { p_sku: p.sku, p: { in_easy_ecom: true } }))}>It’s in Easy Ecom now</Button>
            )}
          </div>
        </div>
      )}
      {!admin && (p.hsn || p.ean) && <p className="text-sm text-stone-600">HSN {p.hsn ?? '—'} · Barcode {p.ean ?? '—'}</p>}

      <ErrorBox>{error}</ErrorBox>

      {combo.length > 0 && (
        <div>
          <div className="mb-1 text-sm font-semibold text-stone-700">Inside this box</div>
          <ul className="text-sm text-stone-700">
            {combo.map((c) => {
              const cp = catalog?.bySku.get(c.component_sku)
              return <li key={c.component_sku}>{c.qty} × {cp ? productLabel(cp) : c.component_sku} <span className="font-mono text-xs text-stone-500">{c.component_sku}</span></li>
            })}
          </ul>
        </div>
      )}

      <div>
        <div className="mb-1 text-sm font-semibold text-stone-700">Other names for this product ({aliases.length})</div>
        <p className="mb-2 text-xs text-stone-500">Any of these, typed in an order or found on a PO, points to SKU {p.sku}.</p>
        <ul className="flex flex-wrap gap-1.5">
          {aliases.map((a) => (
            <li key={a.id} className={`rounded-full border px-2.5 py-1 text-xs ${a.status === 'suggested' ? 'border-dashed border-amber-400 bg-amber-50' : 'border-stone-200 bg-stone-50'}`} title={a.source ?? ''}>
              <span className="text-stone-500">{ALIAS_KINDS[a.kind] ?? a.kind}:</span> {a.alias}{a.status === 'suggested' && ' (to check)'}
            </li>
          ))}
        </ul>
        {admin && (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input value={nick} onChange={(e) => setNick(e.target.value)} placeholder="Add a nickname, e.g. smallest mexican" />
            <Button tone="plain" disabled={busy || !nick.trim()} onClick={() => run(async () => {
              const r = await supabase.rpc('add_alias', { p_sku: p.sku, p_alias: nick })
              if (!r.error) setNick('')
              return r
            })}>Add nickname</Button>
          </div>
        )}
      </div>
    </Card>
  )
}

export default function Products() {
  const { catalog, error, reload } = useCatalog()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('offline')
  const [open, setOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const list = useMemo(() => {
    if (!catalog) return []
    const base = q ? searchProducts(catalog, q, { offlineOnly: filter !== 'all', limit: 100 }) : catalog.products.filter((p) => p.is_offline || filter === 'all')
    return base.filter((p) => filter !== 'retail' || p.is_retail)
  }, [catalog, q, filter])

  const openProduct = open ? catalog?.bySku.get(open) : null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-xl font-bold text-ae-blue">Products</h2>
          <p className="text-sm text-stone-600">Easy Ecom SKUs are the master codes, because every order goes into Easy Ecom.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
        {!adding && <Button onClick={() => setAdding(true)}>+ Add a product</Button>}
        <div className="flex rounded-lg border border-stone-300 bg-white p-1 text-sm font-semibold">
          {([['offline', 'Offline SKUs'], ['retail', 'Retail'], ['all', 'All Easy Ecom']] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setFilter(k)} className={`rounded-md px-3 py-1.5 ${filter === k ? 'bg-ae-blue text-ae-cream' : 'text-stone-600'}`}>{l}</button>
          ))}
        </div>
        </div>
      </div>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search: name, nickname, SKU, barcode, Tally name… (spelling mistakes are fine)" />
      <ErrorBox>{error}</ErrorBox>

      {adding && <AddProduct startName={q} onCancel={() => setAdding(false)} onAdded={(p) => { setAdding(false); reload(); setOpen(p.sku) }} />}
      {openProduct && <ProductDetail key={openProduct.sku} p={openProduct} onClose={() => setOpen(null)} onSaved={() => reload()} />}

      {!catalog ? <p className="text-sm text-stone-500">Loading…</p> : (
        <Card className="p-0 sm:p-0">
          <div className="border-b border-stone-100 px-4 py-2 text-xs text-stone-500">{list.length} products</div>
          <ul className="divide-y divide-stone-100">
            {list.map((p) => (
              <li key={p.sku}>
                <button type="button" onClick={() => { setOpen(p.sku); window.scrollTo({ top: 0, behavior: 'smooth' }) }} className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left hover:bg-ae-cream/40">
                  <div className="min-w-0">
                    <div className="font-semibold text-stone-900">{productLabel(p)}</div>
                    <div className="font-mono text-xs text-stone-500">{p.sku}</div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {p.is_retail && <Badge tone="amber">Retail</Badge>}
                    {p.ee_type === 'Combo' && <Badge>Combo</Badge>}
                    {!p.is_offline && <Badge>Not offline</Badge>}
                    {!p.in_easy_ecom && <Badge tone="red">Not in Easy Ecom</Badge>}
                    {p.site_mrp != null && p.site_mrp !== p.mrp && <Badge tone="amber">Website ₹{p.site_mrp}</Badge>}
                    <TallyBadge p={p} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
