// One-time checks after the import: duplicate customers, drafted nicknames and Tally names.
// Admins decide; everyone else can look.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Button, Card, ErrorBox, Input } from '../components/ui'
import { useAuth } from '../lib/auth'
import { productLabel, searchProducts, useCatalog, type Product } from '../lib/catalog'
import { ago, isAdmin } from '../lib/format'
import { gstinState, GST_STATES, nameSimilarity } from '../lib/match'
import { supabase } from '../lib/supabase'
import { CUSTOMER_COLS, type Customer } from './Customers'

type Tab = 'duplicates' | 'nicknames' | 'tally' | 'prices'

interface Pair { id: number; reason: string; score: number; a: Customer; b: Customer }

/** Small search box that picks an offline product. */
export function ProductPicker({ onPick, placeholder = 'Search for the right product…' }: { onPick: (p: Product) => void; placeholder?: string }) {
  const { catalog } = useCatalog()
  const [q, setQ] = useState('')
  const hits = useMemo(() => (catalog && q ? searchProducts(catalog, q, { offlineOnly: false, limit: 8 }) : []), [catalog, q])
  return (
    <div className="space-y-1">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} autoFocus />
      {hits.length > 0 && (
        <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200 bg-white">
          {hits.map((p) => (
            <li key={p.sku}>
              <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-ae-cream/50" onClick={() => onPick(p)}>
                {productLabel(p)} <span className="font-mono text-xs text-stone-500">{p.sku}</span>
                {!p.is_offline && <span className="ml-1 text-xs text-amber-700">(not an offline SKU)</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Side({ c }: { c: Customer }) {
  const st = gstinState(c.gstin)
  return (
    <div className="min-w-0 space-y-0.5 text-sm">
      <div className="font-semibold text-stone-900">{c.name}</div>
      <div className="text-xs text-stone-500">{c.code} · {c.source ?? '—'}</div>
      <div className="text-stone-700">{c.gstin ? `${c.gstin}${st ? ` (${GST_STATES[st]})` : ''}` : 'No GSTIN'}</div>
      <div className="text-stone-700">{[c.billing_address, c.billing_city].filter(Boolean).join(', ') || 'No address'}</div>
      <div className="text-stone-700">{c.phone ?? 'No phone'}</div>
      <div className="flex flex-wrap gap-1 pt-1">
        {c.in_easy_ecom && <Badge tone="green">Easy Ecom</Badge>}
        {c.in_tally && <Badge>Tally</Badge>}
      </div>
    </div>
  )
}

function Duplicates({ admin, onCount }: { admin: boolean; onCount: (n: number) => void }) {
  const [pairs, setPairs] = useState<Pair[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    const { data } = await supabase.from('customer_duplicates')
      .select(`id, reason, score, a:customers!customer_a(${CUSTOMER_COLS}), b:customers!customer_b(${CUSTOMER_COLS})`)
      .eq('status', 'pending').order('score', { ascending: false }).limit(300)
    const rank = (r: string) => (r === 'same GSTIN' ? 0 : r === 'same phone number' ? 1 : 2)
    const list = ((data ?? []) as unknown as Pair[]).filter((p) => p.a?.active && p.b?.active)
      .sort((x, y) => rank(x.reason) - rank(y.reason) || y.score - x.score)
    setPairs(list)
    onCount(list.length)
    setLoading(false)
  }, [onCount])
  useEffect(() => { load() }, [load])

  const act = async (fn: () => PromiseLike<{ error: { message: string } | null }>) => {
    setError('')
    const { error: e } = await fn()
    if (e) setError(e.message)
    await load()
  }

  // Easy ones: a name that only exists in Tally's customer list, spelt the same as a customer
  // that has full details (only "Pvt Ltd", "LLP" etc. differ). Merging keeps the full record.
  const tallyOnly = (c: Customer) => c.source === 'Tally customer list'
  const easy = pairs.filter((p) => tallyOnly(p.a) !== tallyOnly(p.b) && nameSimilarity(p.a.name, p.b.name) === 1)
  const [bulk, setBulk] = useState('')
  const mergeEasy = async () => {
    if (!confirm(`Merge ${easy.length} Tally names into the matching customer? Each pair is listed below with the same name.`)) return
    let done = 0
    for (const p of easy) {
      const [keep, drop] = tallyOnly(p.a) ? [p.b, p.a] : [p.a, p.b]
      setBulk(`Merging ${++done} of ${easy.length}…`)
      const { error: e } = await supabase.rpc('merge_customers', { p_keep: keep.id, p_drop: drop.id })
      if (e) { setError(e.message); break }
    }
    setBulk('')
    await load()
  }

  if (loading) return <p className="text-sm text-stone-500">Loading…</p>
  if (!pairs.length) return <p className="text-sm text-stone-600">No possible duplicates left. 🎉</p>
  return (
    <div className="space-y-3">
      {admin && easy.length > 0 && (
        <Card className="border-ae-blue/30 bg-ae-yellow/20">
          <p className="text-sm text-stone-700">
            <b>{easy.length} quick ones:</b> a name from Tally’s customer list that is spelt the same as a customer with full details
            (only words like “Pvt Ltd” or “LLP” differ). Merging keeps the full record and remembers the Tally name.
          </p>
          <Button className="mt-2" disabled={!!bulk} onClick={mergeEasy}>{bulk || `Merge all ${easy.length}`}</Button>
        </Card>
      )}
      <p className="text-sm text-stone-600">
        Are these the same customer? <b>Merge</b> keeps one record and moves the other’s addresses and details into it (nothing is lost).
        <b> Different</b> keeps both. Blinkit warehouses and Foodstories stores are usually <i>one</i> customer with many delivery addresses.
      </p>
      <ErrorBox>{error}</ErrorBox>
      {pairs.map((p) => (
        <Card key={p.id}>
          <div className="mb-2"><Badge tone={p.reason === 'same GSTIN' ? 'red' : 'amber'}>{p.reason}</Badge></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Side c={p.a} />
            <Side c={p.b} />
          </div>
          {admin && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button className="min-h-10 px-3 text-sm" onClick={() => act(() => supabase.rpc('merge_customers', { p_keep: p.a.id, p_drop: p.b.id }))}>Same: keep left</Button>
              <Button className="min-h-10 px-3 text-sm" onClick={() => act(() => supabase.rpc('merge_customers', { p_keep: p.b.id, p_drop: p.a.id }))}>Same: keep right</Button>
              <Button tone="plain" className="min-h-10 px-3 text-sm" onClick={() => act(() => supabase.rpc('keep_separate', { p_pair: p.id }))}>Different customers</Button>
            </div>
          )}
        </Card>
      ))}
    </div>
  )
}

function Nicknames({ admin, onCount }: { admin: boolean; onCount: (n: number) => void }) {
  const { catalog, reload } = useCatalog()
  const [changing, setChanging] = useState<number | null>(null)
  const [error, setError] = useState('')
  const list = useMemo(() => (catalog?.aliases ?? []).filter((a) => a.status === 'suggested' && a.kind === 'nickname').sort((a, b) => b.times_seen - a.times_seen), [catalog])
  useEffect(() => onCount(list.length), [list.length, onCount])

  const act = async (id: number, accept: boolean, sku?: string) => {
    setError('')
    const { error: e } = await supabase.rpc('review_alias', { p_id: id, p_accept: accept, p_sku: sku ?? null })
    if (e) setError(e.message)
    setChanging(null)
    await reload()
  }

  if (!catalog) return <p className="text-sm text-stone-500">Loading…</p>
  if (!list.length) return <p className="text-sm text-stone-600">All nicknames checked. 🎉</p>
  return (
    <div className="space-y-3">
      <p className="text-sm text-stone-600">
        These words were found again and again in the old order forms and WhatsApp chats. Is the product on the right what people mean?
        Each one you confirm means one less question on the order form.
      </p>
      <ErrorBox>{error}</ErrorBox>
      <Card className="p-0 sm:p-0">
        <ul className="divide-y divide-stone-100">
          {list.map((a) => {
            const p = catalog.bySku.get(a.sku)
            return (
              <li key={a.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 text-sm">
                    <span className="font-semibold text-stone-900">“{a.alias}”</span>
                    <span className="text-stone-500"> · seen {a.times_seen} times</span>
                    <div className="text-stone-700">→ {p ? productLabel(p) : a.sku} <span className="font-mono text-xs text-stone-500">{a.sku}</span></div>
                  </div>
                  {admin && (
                    <div className="flex gap-2">
                      <Button className="min-h-10 px-3 text-sm" onClick={() => act(a.id, true)}>Right</Button>
                      <Button tone="plain" className="min-h-10 px-3 text-sm" onClick={() => setChanging(changing === a.id ? null : a.id)}>Other product</Button>
                      <Button tone="danger" className="min-h-10 px-3 text-sm" onClick={() => act(a.id, false)}>Ignore</Button>
                    </div>
                  )}
                </div>
                {changing === a.id && <div className="mt-2"><ProductPicker onPick={(np) => act(a.id, true, np.sku)} /></div>}
              </li>
            )
          })}
        </ul>
      </Card>
    </div>
  )
}

function TallyNames({ canEdit, onCount }: { canEdit: boolean; onCount: (n: number) => void }) {
  const { catalog, reload } = useCatalog()
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [tallyNames, setTallyNames] = useState<string[]>([])
  const [error, setError] = useState('')
  const list = useMemo(() => (catalog?.products ?? []).filter((p) => p.is_offline && p.tally_status !== 'confirmed')
    .sort((a, b) => (a.tally_status === 'none' ? 0 : 1) - (b.tally_status === 'none' ? 0 : 1) || a.name.localeCompare(b.name)), [catalog])
  useEffect(() => onCount(list.length), [list.length, onCount])
  useEffect(() => {
    if (canEdit) supabase.from('tally_items').select('name').order('name').limit(1000).then(({ data }) => setTallyNames((data ?? []).map((r) => r.name)))
  }, [canEdit])

  const save = async (p: Product) => {
    setError('')
    const { error: e } = await supabase.rpc('set_tally_name', { p_sku: p.sku, p_name: edits[p.sku] ?? p.tally_name ?? '' })
    if (e) setError(e.message)
    await reload()
  }

  if (!catalog) return <p className="text-sm text-stone-500">Loading…</p>
  if (!list.length) return <p className="text-sm text-stone-600">Every offline product has a confirmed Tally name. 🎉</p>
  return (
    <div className="space-y-3">
      <p className="text-sm text-stone-600">
        The Tally stock item name for each offline product, so accounts pick the right item when making the invoice.
        Check the suggestion, change it if needed (start typing to see Tally’s names), then press Confirm.
      </p>
      <ErrorBox>{error}</ErrorBox>
      <datalist id="tally-list">{tallyNames.map((n) => <option key={n} value={n} />)}</datalist>
      <Card className="p-0 sm:p-0">
        <ul className="divide-y divide-stone-100">
          {list.map((p) => (
            <li key={p.sku} className="space-y-2 px-4 py-3">
              <div className="text-sm">
                <span className="font-semibold text-stone-900">{productLabel(p)}</span> <span className="font-mono text-xs text-stone-500">{p.sku}</span>
                {p.tally_status === 'none' && <span className="ml-2"><Badge tone="red">no suggestion</Badge></span>}
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input list="tally-list" value={edits[p.sku] ?? p.tally_name ?? ''} disabled={!canEdit} placeholder="Tally item name"
                  onChange={(e) => setEdits((v) => ({ ...v, [p.sku]: e.target.value }))} />
                {canEdit && <Button className="min-h-10 px-4 text-sm" disabled={!(edits[p.sku] ?? p.tally_name)} onClick={() => save(p)}>Confirm</Button>}
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}

function Prices({ admin, onCount }: { admin: boolean; onCount: (n: number) => void }) {
  const { catalog, reload } = useCatalog()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const list = useMemo(() => (catalog?.products ?? [])
    .filter((p) => p.site_mrp != null && p.site_mrp !== p.mrp)
    .sort((a, b) => Number(b.is_offline) - Number(a.is_offline) || a.name.localeCompare(b.name)), [catalog])
  useEffect(() => onCount(list.length), [list.length, onCount])
  const last = (catalog?.products ?? []).map((p) => p.site_checked_at).filter(Boolean).sort().pop() ?? null

  const accept = async (skus: string[]) => {
    setError('')
    setBusy('Saving…')
    const { error: e } = await supabase.rpc('accept_site_prices', { p_skus: skus })
    if (e) setError(e.message)
    setBusy('')
    await reload()
  }
  const checkNow = async () => {
    setError('')
    setBusy('Checking atomeats.com…')
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/site-prices`, {
      method: 'POST', headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' }, body: '{}',
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) setError(body.error ?? 'The check didn’t work. Please try again.')
    setBusy('')
    await reload()
  }

  if (!catalog) return <p className="text-sm text-stone-500">Loading…</p>
  return (
    <div className="space-y-3">
      <p className="text-sm text-stone-600">
        The Hub checks the prices on atomeats.com every 6 hours. These products have a different price on the website than in the Hub.
        The Hub’s MRP is what “MRP minus margin” uses on new orders. Prices never change by themselves: an admin decides here.
        {last && <> Last checked {ago(last)}.</>}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button tone="plain" disabled={!!busy} onClick={checkNow}>{busy || 'Check the website now'}</Button>
        {admin && list.length > 0 && <Button disabled={!!busy} onClick={() => confirm(`Use the website price for all ${list.length} products?`) && accept(list.map((p) => p.sku))}>Use the website price for all {list.length}</Button>}
      </div>
      <ErrorBox>{error}</ErrorBox>
      {!list.length ? <p className="text-sm text-stone-600">Every price matches atomeats.com. 🎉</p> : (
        <Card className="p-0 sm:p-0">
          <ul className="divide-y divide-stone-100">
            {list.map((p) => (
              <li key={p.sku} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <div className="min-w-0 text-sm">
                  <div className="font-semibold text-stone-900">{p.name} {p.size && <span className="font-normal text-stone-500">· {p.size}</span>}</div>
                  <div className="text-stone-700">Hub ₹{p.mrp ?? '—'} → website <b>₹{p.site_mrp}</b> <span className="font-mono text-xs text-stone-500">{p.sku}</span>{p.is_offline && <span className="ml-1"><Badge tone="green">offline SKU</Badge></span>}</div>
                </div>
                {admin && <Button className="min-h-10 px-3 text-sm" disabled={!!busy} onClick={() => accept([p.sku])}>Use ₹{p.site_mrp}</Button>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

export default function Checks() {
  const { me } = useAuth()
  const admin = isAdmin(me?.role)
  const [tab, setTab] = useState<Tab>('duplicates')
  const [counts, setCounts] = useState<Record<Tab, number | null>>({ duplicates: null, nicknames: null, tally: null, prices: null })
  const setCount = useCallback((t: Tab) => (n: number) => setCounts((c) => (c[t] === n ? c : { ...c, [t]: n })), [])
  const dupCount = useMemo(() => setCount('duplicates'), [setCount])
  const nickCount = useMemo(() => setCount('nicknames'), [setCount])
  const tallyCount = useMemo(() => setCount('tally'), [setCount])
  const priceCount = useMemo(() => setCount('prices'), [setCount])
  // Counts for all three tabs straight away, not just the open one.
  useEffect(() => {
    Promise.all([
      supabase.from('customer_duplicates').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('product_aliases').select('id', { count: 'exact', head: true }).eq('status', 'suggested').eq('kind', 'nickname'),
      supabase.from('products').select('sku', { count: 'exact', head: true }).eq('is_offline', true).neq('tally_status', 'confirmed'),
    ]).then(([d, n, t]) => setCounts((c) => ({ ...c, duplicates: c.duplicates ?? d.count, nicknames: c.nicknames ?? n.count, tally: c.tally ?? t.count })))
  }, [])

  const tabs: [Tab, string][] = [['duplicates', 'Duplicate customers'], ['nicknames', 'Nicknames'], ['tally', 'Tally names'], ['prices', 'Prices']]
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-ae-blue">Checks</h2>
        <p className="text-sm text-stone-600">Things the import couldn’t be sure about. {admin ? 'Work through them in any order; your answers are saved straight away.' : 'Admins go through these.'}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {tabs.map(([k, l]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={`rounded-full border px-4 py-2 text-sm font-semibold ${tab === k ? 'border-ae-blue bg-ae-blue text-ae-cream' : 'border-stone-300 bg-white text-stone-700'}`}>
            {l}{counts[k] != null && <span className="ml-1.5 opacity-80">({counts[k]})</span>}
          </button>
        ))}
      </div>
      {tab === 'duplicates' && <Duplicates admin={admin} onCount={dupCount} />}
      {tab === 'nicknames' && <Nicknames admin={admin} onCount={nickCount} />}
      {tab === 'prices' && <Prices admin={admin} onCount={priceCount} />}
      {tab === 'tally' && <TallyNames canEdit={admin || me?.role === 'accounts'} onCount={tallyCount} />}
    </div>
  )
}
