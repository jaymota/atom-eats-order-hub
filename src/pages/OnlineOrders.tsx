// atomeats.com (Shopify) orders, copied in every 15 minutes. View-only: they go to Easy Ecom from
// Shopify itself, so nothing here is uploaded or changed.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Button, Card, ErrorBox, Input } from '../components/ui'
import { fetchAll } from '../lib/catalog'
import { ago } from '../lib/format'
import { rupees } from '../lib/stages'

interface Row {
  id: number; name: string; ordered_at: string; customer: string | null; city: string | null; total: number
  paid: string | null; shipped: string | null; cancelled: boolean; synced_at: string
  lines: { sku: string; title: string; qty: number; open: number }[]
}
type Tab = 'open' | 'sent' | 'cancelled'
const TABS: [Tab, string][] = [['open', 'To ship'], ['sent', 'Shipped'], ['cancelled', 'Cancelled']]
const tabOf = (r: Row): Tab => (r.cancelled ? 'cancelled' : r.lines.some((l) => l.open > 0) ? 'open' : 'sent')
const word = (s: string | null) => (s ?? '').toLowerCase().replace(/_/g, ' ')

export default function OnlineOrders() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [known, setKnown] = useState<Set<string>>(new Set())
  const [tab, setTab] = useState<Tab>('open')
  const [find, setFind] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(() => Promise.all([
    fetchAll<Row>('shopify_orders', 'id, name, ordered_at, customer, city, total, paid, shipped, cancelled, synced_at, lines', (q) => q.order('ordered_at', { ascending: false })),
    fetchAll<{ sku: string }>('products', 'sku'),
  ]).then(([r, p]) => { setRows(r); setKnown(new Set(p.map((x) => x.sku))) }).catch((e) => setError(e.message)), [])
  useEffect(() => { load() }, [load])

  const refresh = async () => {
    setBusy(true); setError('')
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/shopify-sync`, {
      method: 'POST', headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' }, body: '{}',
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.error) setError(body.error ?? 'That didn’t work. Please try again.')
    await load()
    setBusy(false)
  }

  const counts = useMemo(() => Object.fromEntries(TABS.map(([k]) => [k, (rows ?? []).filter((r) => tabOf(r) === k).length])), [rows])
  const list = useMemo(() => {
    const q = find.trim().toLowerCase()
    return (rows ?? []).filter((r) => tabOf(r) === tab && (!q || `${r.name} ${r.customer ?? ''} ${r.city ?? ''} ${r.lines.map((l) => `${l.sku} ${l.title}`).join(' ')}`.toLowerCase().includes(q)))
  }, [rows, tab, find])
  const last = rows?.reduce((m, r) => (r.synced_at > m ? r.synced_at : m), '')

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-bold text-ae-blue">Online orders</h2>
        <Input className="min-h-10 max-w-56 text-sm" placeholder="Search" value={find} onChange={(e) => setFind(e.target.value)} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-stone-300 bg-white p-0.5 text-sm">
          {TABS.map(([k, label]) => (
            <button key={k} type="button" onClick={() => setTab(k)} className={`rounded-md px-3 py-1.5 font-semibold ${tab === k ? 'bg-ae-blue text-ae-cream' : 'text-stone-600'}`}>{label} ({counts[k] ?? 0})</button>
          ))}
        </div>
        <span className="text-xs text-stone-500">atomeats.com · {last ? `updated ${ago(last)}` : 'not linked yet'}</span>
        <Button tone="plain" className="min-h-9 px-3 text-sm" disabled={busy} onClick={refresh}>{busy ? 'Updating…' : 'Update now'}</Button>
      </div>
      <ErrorBox>{error}</ErrorBox>
      {!rows ? <p className="text-sm text-stone-500">Loading…</p> : !list.length ? <Card><p className="text-stone-600">Nothing here.</p></Card> : (
        <ul className="space-y-2">
          {list.map((r) => (
            <li key={r.id}>
              <Card className="space-y-1 p-3 sm:p-4">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-semibold text-stone-900">{r.name}</span>
                  <span className="text-sm text-stone-500">{new Date(r.ordered_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>
                  {r.paid && <Badge tone={r.paid === 'PAID' ? 'green' : 'amber'}>{word(r.paid)}</Badge>}
                  {!r.cancelled && r.shipped && r.shipped !== 'UNFULFILLED' && <Badge>{word(r.shipped)}</Badge>}
                  <span className="ml-auto font-semibold tabular-nums text-stone-900">{rupees(r.total)}</span>
                </div>
                {(r.customer || r.city) && <div className="text-sm text-stone-600">{[r.customer, r.city].filter(Boolean).join(' · ')}</div>}
                <ul className="text-sm text-stone-800">
                  {r.lines.map((l, i) => (
                    <li key={i}>
                      {l.qty}× {l.title} <span className="font-mono text-xs text-stone-500">{l.sku}</span>
                      {l.sku && !known.has(l.sku) && <> <Badge tone="amber">Unknown product</Badge></>}
                      {l.open > 0 && l.open < l.qty && <span className="text-xs text-stone-500"> · {l.open} to ship</span>}
                    </li>
                  ))}
                </ul>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
