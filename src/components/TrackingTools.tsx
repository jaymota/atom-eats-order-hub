// Fulfilling website orders from the Hub: label photos or a tracking file → a check list → Fulfil.
// Shopify marks each order fulfilled with its tracking and emails the customer as usual.
import { useMemo, useRef, useState } from 'react'
import { Badge, Button, Card, ErrorBox, Input, OkBox, Select } from './ui'
import { matchOrder, trackingFrom, type OpenOrder } from '../lib/labels'
import { SUPABASE_KEY, SUPABASE_URL, supabase } from '../lib/supabase'

export const ONLINE_COURIERS = ['DTDC', 'Blue Dart', 'Delhivery', 'Porter']

interface Line { key: string; photo?: string; tracking: string; fromText: boolean; orderId: number | null; sure: boolean; courier: string; done?: string; error?: string }

/** Sends orders to Shopify, 10 at a time. Returns a result per order id. */
export async function fulfil(items: { id: number; tracking: string; company: string }[]) {
  const { data: s } = await supabase.auth.getSession()
  const out: { id: number; name?: string; ok: boolean; error?: string }[] = []
  for (let i = 0; i < items.length; i += 10) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/shopify-fulfil`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${s.session?.access_token ?? ''}` },
      body: JSON.stringify({ orders: items.slice(i, i + 10) }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.error) throw new Error(body.error ?? 'That didn’t work. Please try again.')
    out.push(...body.results)
  }
  return out
}

const TEMPLATE = 'Order no.,Tracking no.,Courier\n13349,7X123927480,DTDC\n'

export default function TrackingTools({ open, onDone }: { open: OpenOrder[]; onDone: () => void }) {
  const [lines, setLines] = useState<Line[] | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const photoRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const byId = useMemo(() => new Map(open.map((o) => [o.id, o])), [open])

  const fromPhotos = async (files: File[]) => {
    setError(''); setMsg('')
    try {
      const { readLabels } = await import('../lib/readers')
      const read = await readLabels(files, (m) => setBusy(m), (text, barcodes) => !matchOrder(text, open).sure || !trackingFrom(barcodes, text))
      setLines(read.map((r, i) => {
        const t = trackingFrom(r.barcodes, r.text)
        const m = matchOrder(r.text, open)
        return { key: `${Date.now()}-${i}`, photo: URL.createObjectURL(files[i]), tracking: t?.tracking ?? '', fromText: t?.from !== 'barcode', orderId: m.sure ? m.order!.id : null, sure: m.sure, courier: 'DTDC' }
      }))
    } catch (e) { setError((e as Error).message) }
    setBusy('')
  }

  const fromFile = async (file: File) => {
    setError(''); setMsg('')
    try {
      const X = await import('xlsx')
      const wb = X.read(await file.arrayBuffer(), { type: 'array' })
      const rows = X.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false })
      const head = (rows[0] ?? []).map((c) => String(c).toLowerCase())
      const col = (re: RegExp) => head.findIndex((c) => re.test(c))
      const cNo = col(/order/), cTrack = col(/track|awb|docket/), cCourier = col(/courier|carrier/)
      if (cNo < 0 || cTrack < 0) throw new Error('The file needs “Order no.” and “Tracking no.” columns.')
      const byName = new Map(open.map((o) => [o.name.replace('#', ''), o]))
      setLines(rows.slice(1).filter((r) => String(r[cNo]).trim()).map((r, i) => {
        const o = byName.get(String(r[cNo]).replace(/\D/g, ''))
        const c = String(r[cCourier] ?? '').trim()
        return { key: `${Date.now()}-${i}`, tracking: String(r[cTrack]).trim().toUpperCase(), fromText: false, orderId: o?.id ?? null, sure: !!o,
          courier: ONLINE_COURIERS.find((x) => x.toLowerCase().replace(/\s/g, '') === c.toLowerCase().replace(/\s/g, '')) ?? 'DTDC' }
      }))
    } catch (e) { setError((e as Error).message) }
  }

  const set = (key: string, patch: Partial<Line>) => setLines((ls) => ls!.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const twice = (l: Line) => (lines ?? []).filter((x) => !x.done && ((l.orderId && x.orderId === l.orderId) || (l.tracking && x.tracking === l.tracking))).length > 1
  // Only rows the Hub is certain of, or the team picked or typed, go to Shopify.
  const ready = (lines ?? []).filter((l) => !l.done && l.orderId && l.sure && l.tracking && !twice(l))

  const send = async () => {
    setBusy('Sending to Shopify…'); setError(''); setMsg('')
    try {
      const res = await fulfil(ready.map((l) => ({ id: l.orderId!, tracking: l.tracking, company: l.courier })))
      setLines((ls) => ls!.map((l) => {
        const r = res.find((x) => x.id === l.orderId)
        return r && ready.includes(l) ? { ...l, done: r.ok ? '✓' : undefined, error: r.ok ? undefined : r.error } : l
      }))
      const ok = res.filter((r) => r.ok).length
      setMsg(`${ok} fulfilled.`)
      if (res.some((r) => !r.ok)) setError(res.find((r) => !r.ok)!.error ?? '')
      onDone()
    } catch (e) { setError((e as Error).message) }
    setBusy('')
  }

  if (!lines) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button className="min-h-9 px-3 text-sm" disabled={!!busy} onClick={() => photoRef.current?.click()}>{busy || '📷 Tracking photos'}</Button>
        <Button tone="plain" className="min-h-9 px-3 text-sm" disabled={!!busy} onClick={() => fileRef.current?.click()}>Upload tracking</Button>
        <a className="text-xs text-stone-500 underline" href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`} download="tracking-template.csv">Template</a>
        <input ref={photoRef} type="file" accept="image/*" multiple hidden onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) fromPhotos(f) }} />
        <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) fromFile(f) }} />
        <ErrorBox>{error}</ErrorBox>
      </div>
    )
  }

  return (
    <Card className="space-y-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-ae-blue">Check tracking ({lines.length})</h3>
        <Select className="min-h-9 max-w-40 text-sm" aria-label="Courier for all" value="" onChange={(e) => e.target.value && setLines(lines.map((l) => (l.done ? l : { ...l, courier: e.target.value })))}>
          <option value="">Courier for all…</option>
          {ONLINE_COURIERS.map((c) => <option key={c}>{c}</option>)}
        </Select>
      </div>
      <ul className="divide-y divide-stone-100">
        {lines.map((l) => {
          const o = l.orderId ? byId.get(l.orderId) : undefined
          const warn = !l.done && (!l.orderId || !l.sure || !l.tracking || l.fromText || twice(l))
          return (
            <li key={l.key} className={`grid grid-cols-[4rem_1fr_auto] items-center gap-2 px-1 py-2 sm:grid-cols-[4rem_11rem_1fr_8rem_auto] ${warn ? 'bg-amber-50' : ''}`}>
              {l.photo ? <a href={l.photo} target="_blank" rel="noreferrer" className="row-span-3 sm:row-span-1"><img src={l.photo} alt="" className="h-16 w-16 rounded-lg border object-cover" /></a> : <span className="row-span-3 sm:row-span-1" />}
              <Input className={`min-h-10 font-mono text-sm ${l.fromText && !l.done ? 'border-amber-400' : ''}`} aria-label="Tracking no." placeholder="Tracking no." value={l.tracking} disabled={!!l.done}
                onChange={(e) => set(l.key, { tracking: e.target.value.toUpperCase().replace(/\s/g, ''), fromText: false })} />
              <Select className={`col-start-2 min-h-10 text-sm sm:col-start-auto ${!l.sure && !l.done ? 'border-amber-400' : ''}`} aria-label="Order" value={l.orderId ?? ''} disabled={!!l.done}
                onChange={(e) => set(l.key, { orderId: Number(e.target.value) || null, sure: true })}>
                <option value="">Pick the order…</option>
                {o && !open.includes(o) && <option value={o.id}>{o.name}</option>}
                {open.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.customer ?? ''}{x.city ? ` · ${x.city}` : ''}</option>)}
              </Select>
              <Select className="col-start-2 min-h-10 text-sm sm:col-start-auto" aria-label="Courier" value={l.courier} disabled={!!l.done} onChange={(e) => set(l.key, { courier: e.target.value })}>
                {ONLINE_COURIERS.map((c) => <option key={c}>{c}</option>)}
              </Select>
              <div className="col-start-3 row-start-1 flex items-center gap-1 justify-self-end sm:col-start-auto sm:row-start-auto">
                {l.done ? <Badge tone="green">Fulfilled</Badge> : twice(l) ? <Badge tone="amber">Twice</Badge> : l.error ? <Badge tone="red">{l.error}</Badge> : null}
                {!l.done && <button type="button" aria-label="Remove" className="px-2 text-stone-400" onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>✕</button>}
              </div>
            </li>
          )
        })}
      </ul>
      <OkBox>{msg}</OkBox>
      <ErrorBox>{error}</ErrorBox>
      <div className="flex gap-2">
        <Button disabled={!!busy || !ready.length} onClick={send}>{busy || `Fulfil (${ready.length})`}</Button>
        <Button tone="plain" disabled={!!busy} onClick={() => { setLines(null); setMsg(''); setError('') }}>{lines.some((l) => l.done) ? 'Done' : 'Back'}</Button>
      </div>
    </Card>
  )
}

/** "+ Tracking" on one order. */
export function OneTracking({ id, onDone }: { id: number; onDone: () => void }) {
  const [on, setOn] = useState(false)
  const [tracking, setTracking] = useState('')
  const [courier, setCourier] = useState('DTDC')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!on) return <button type="button" className="text-sm font-semibold text-ae-blue underline" onClick={() => setOn(true)}>+ Tracking</button>
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        <Input className="min-h-10 w-40 font-mono text-sm" placeholder="Tracking no." aria-label="Tracking no." value={tracking} onChange={(e) => setTracking(e.target.value.toUpperCase().replace(/\s/g, ''))} />
        <Select className="min-h-10 w-32 text-sm" aria-label="Courier" value={courier} onChange={(e) => setCourier(e.target.value)}>
          {ONLINE_COURIERS.map((c) => <option key={c}>{c}</option>)}
        </Select>
        <Button className="min-h-10 px-3 text-sm" disabled={busy || !tracking} onClick={async () => {
          setBusy(true); setError('')
          try {
            const [r] = await fulfil([{ id, tracking, company: courier }])
            if (!r.ok) throw new Error(r.error)
            onDone()
          } catch (e) { setError((e as Error).message) }
          setBusy(false)
        }}>{busy ? 'Sending…' : 'Fulfil'}</Button>
        <Button tone="plain" className="min-h-10 px-3 text-sm" onClick={() => setOn(false)}>Back</Button>
      </div>
      <ErrorBox>{error}</ErrorBox>
    </div>
  )
}
