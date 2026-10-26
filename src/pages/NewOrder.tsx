// The one order form for everyone: give the order as it is (paste, photo, PO file, or blank),
// answer a few questions, check and save.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, Card, ErrorBox, Input, OkBox } from '../components/ui'
import AddProduct from '../components/AddProduct'
import OrderReview from '../components/OrderReview'
import { useAuth } from '../lib/auth'
import { loadCatalog, productLabel, searchProducts, useCatalog, type Catalog, type Product } from '../lib/catalog'
import { nameSimilarity, norm, tidy } from '../lib/match'
import {
  MESSAGE_TEMPLATE, applyCustomer, emptyDraft, loadCustomersLite, newKey, splitAddress, stateFromGstin, type Draft, type DraftLine,
} from '../lib/orders'
import { cleanOcr, readBarcodeRows, readMessage, type RawItem, type ReadMessage } from '../lib/parse'
import { readExcel, readImage, readPdf, readScannedPdf } from '../lib/readers'
import { guessCustomerNames, resolveCustomer, resolveItems, type CustomerGuess, type CustomerLite, type ResolvedItem } from '../lib/resolve'
import { supabase } from '../lib/supabase'
import { CHANNELS, CHANNEL_HINT } from '../lib/channels'

type Q =
  | { kind: 'customer' }
  | { kind: 'product'; item: ResolvedItem }
  | { kind: 'qty' }
  | { kind: 'address' }
  | { kind: 'channel' }
  | { kind: 'margin' }
  | { kind: 'po' }

interface Analysis {
  read: ReadMessage | null
  items: ResolvedItem[]
  guess: CustomerGuess
  names: string[]
}

/** A draft line, carrying the PO's own rate and barcode when the item came from a PO. */
function poLine(cat: Catalog, item: ResolvedItem, sku: string, qty: number | null): DraftLine {
  const si = item.raw as PoItem
  const gst = cat.bySku.get(sku)?.gst_rate ?? 5
  const rate = si.rate ?? (si.basic ? Math.round(si.basic * (1 + gst / 100) * 100) / 100 : null)
  return {
    key: newKey(), sku, qty, typed_as: item.typed, learn: false, ean_seen: si.ean ?? null,
    price_basis: rate != null ? 'po_rate' : null, margin_pct: null, rate,
  }
}

const BIG = 'min-h-14 w-full rounded-xl border-2 px-4 py-3 text-left text-base font-semibold transition-colors'

// ---------------------------------------------------------------- step 1: the order as it is

type PoItem = RawItem & { ean?: string; rate?: number; basic?: number }

function InputStep({ onRead, onBlank }: { onRead: (text: string, files: File[], source: string, sheetItems?: PoItem[]) => void; onBlank: () => void }) {
  const [mode, setMode] = useState<'pick' | 'paste'>('pick')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const imgRef = useRef<HTMLInputElement>(null)
  const poRef = useRef<HTMLInputElement>(null)

  const progress = (m: string, f?: number) => setBusy(f != null ? `${m} ${Math.round(f * 100)}%` : m)

  const fromImages = async (files: File[]) => {
    setError('')
    try {
      const parts: string[] = []
      let low = false
      for (const [i, f] of files.entries()) {
        const r = await readImage(f, (m, fr) => progress(files.length > 1 ? `${m} (${i + 1} of ${files.length})` : m, fr))
        if (r.confidence < 60) low = true
        parts.push(cleanOcr(r.text))
      }
      setBusy('')
      if (low) setError('Parts of the picture were hard to read (handwriting?). Check the answers carefully, or use “Start blank”.')
      onRead(parts.join('\n\n'), files, 'screenshot')
    } catch (e) {
      setBusy('')
      setError(`Couldn’t read the picture: ${(e as Error).message}`)
    }
  }

  const fromPo = async (f: File) => {
    setError('')
    try {
      if (/\.(xlsx|xls|csv)$/i.test(f.name)) {
        progress('Reading the Excel file…')
        const r = await readExcel(f)
        setBusy('')
        onRead(r.text, [f], 'po_file', r.items)
      } else {
        let t = await readPdf(f, progress)
        if (t.replace(/\s/g, '').length < 40) t = cleanOcr(await readScannedPdf(f, progress))
        setBusy('')
        onRead(t, [f], 'po_file')
      }
    } catch (e) {
      setBusy('')
      setError(`Couldn’t read the file: ${(e as Error).message}`)
    }
  }

  if (busy) {
    return <Card className="py-10 text-center"><p className="text-lg font-semibold text-ae-blue">{busy}</p><p className="mt-2 text-sm text-stone-500">This happens on your phone or computer, nothing is sent anywhere.</p></Card>
  }

  if (mode === 'paste') {
    return (
      <Card className="space-y-3">
        <h3 className="font-semibold text-ae-blue">Paste the WhatsApp message</h3>
        <p className="text-sm text-stone-600">Paste it exactly as you got it. Several messages together are fine (items in one, address in another).</p>
        <textarea className="min-h-64 w-full rounded-lg border border-stone-300 bg-white p-3 text-base focus:border-ae-blue focus:outline-none" value={text} onChange={(e) => setText(e.target.value)} autoFocus placeholder="Paste here…" />
        <div className="flex gap-2">
          <Button tone="plain" onClick={() => setMode('pick')}>Back</Button>
          <Button className="flex-1" disabled={!text.trim()} onClick={() => onRead(text, [], 'paste')}>Read the message</Button>
        </div>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      <ErrorBox>{error}</ErrorBox>
      <button type="button" className={`${BIG} border-ae-blue bg-ae-blue text-ae-cream`} onClick={() => setMode('paste')}>
        📋 Paste a WhatsApp message<div className="text-sm font-normal opacity-90">The quickest way. Paste the chat text as it is.</div>
      </button>
      <button type="button" className={`${BIG} border-ae-blue/30 bg-white text-ae-blue`} onClick={() => imgRef.current?.click()}>
        📷 Upload a screenshot or photo<div className="text-sm font-normal text-stone-600">WhatsApp chat, or a printed PO. (Handwriting doesn’t read well: use Start blank.)</div>
      </button>
      <button type="button" className={`${BIG} border-ae-blue/30 bg-white text-ae-blue`} onClick={() => poRef.current?.click()}>
        📄 Upload a PO file<div className="text-sm font-normal text-stone-600">PDF or Excel, as the customer sent it.</div>
      </button>
      <button type="button" className={`${BIG} border-stone-300 bg-white text-stone-700`} onClick={onBlank}>
        ✏️ Start blank<div className="text-sm font-normal text-stone-500">Pick the customer and products yourself.</div>
      </button>
      <input ref={imgRef} type="file" accept="image/*" multiple hidden onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) fromImages(f) }} />
      <input ref={poRef} type="file" accept=".pdf,.xlsx,.xls,.csv,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) fromPo(f) }} />
      <div className="pt-2 text-center">
        <button type="button" className="text-sm font-semibold text-ae-blue underline" onClick={async () => {
          await navigator.clipboard.writeText(MESSAGE_TEMPLATE).catch(() => {})
          setCopied(true)
        }}>Copy the message template</button>
        {copied && <p className="mt-1 text-xs text-stone-500">Copied. Send it to a customer so their details arrive complete (optional).</p>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- the questions

function ProductOption({ p, chosen, onClick }: { p: Product; chosen: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`flex w-full items-center gap-3 rounded-xl border-2 p-2 text-left ${chosen ? 'border-ae-blue bg-ae-blue/5' : 'border-stone-200 bg-white'}`}>
      {p.image_url ? <img src={p.image_url} alt="" className="h-16 w-16 shrink-0 rounded-lg object-cover" loading="lazy" /> : <div className="h-16 w-16 shrink-0 rounded-lg bg-ae-cream" />}
      <div className="min-w-0">
        <div className="font-semibold text-stone-900">{productLabel(p)}</div>
        <div className="font-mono text-xs text-stone-500">{p.sku}</div>
      </div>
    </button>
  )
}

function ProductQuestion({ item, catalog, onAnswer }: { item: ResolvedItem; catalog: Catalog; onAnswer: (sku: string | null, qty: number | null) => void }) {
  const [pick, setPick] = useState<string | null>(item.options[0]?.sku ?? null)
  const [qty, setQty] = useState<string>(item.qty != null ? String(item.qty) : '')
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const hits = useMemo(() => (q ? searchProducts(catalog, q, { limit: 6 }) : []), [catalog, q])
  if (adding) return <AddProduct startName={q || item.raw.text} onCancel={() => setAdding(false)} onAdded={(p) => onAnswer(p.sku, qty ? Number(qty) : null)} />
  return (
    <div className="space-y-3">
      <p className="text-lg text-stone-800">The message says <b>“{item.raw.text}”</b>{item.qty != null && <> × <b>{item.qty}</b></>}. Which product is it?</p>
      <div className="space-y-2">
        {item.options.map((p) => <ProductOption key={p.sku} p={p} chosen={pick === p.sku} onClick={() => setPick(p.sku)} />)}
        {hits.filter((h) => !item.options.some((o) => o.sku === h.sku)).map((p) => <ProductOption key={p.sku} p={p} chosen={pick === p.sku} onClick={() => setPick(p.sku)} />)}
      </div>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Something else? Search…" />
      <button type="button" className="text-sm font-semibold text-ae-blue underline" onClick={() => setAdding(true)}>Not in the list? Add a new product</button>
      <label className="block text-sm font-semibold text-stone-700">How many?
        <Input className="mt-1" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} placeholder="Number of packs" />
      </label>
      <div className="flex gap-2">
        <Button tone="plain" onClick={() => onAnswer(null, null)}>Not a product, skip</Button>
        <Button className="flex-1" disabled={!pick} onClick={() => onAnswer(pick, qty ? Number(qty) : null)}>Next</Button>
      </div>
    </div>
  )
}

function QtyQuestion({ lines, catalog, onAnswer }: { lines: DraftLine[]; catalog: Catalog; onAnswer: (q: Record<string, number | null>) => void }) {
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(lines.map((l) => [l.key, l.qty ? String(l.qty) : ''])))
  const [all, setAll] = useState('')
  return (
    <div className="space-y-3">
      <p className="text-lg text-stone-800">How many of each? <span className="text-sm text-stone-500">(the message didn’t say)</span></p>
      <div className="flex items-end gap-2 rounded-lg bg-ae-cream/60 p-2">
        <label className="flex-1 text-sm font-semibold text-stone-700">Same number for all
          <Input className="mt-1" inputMode="numeric" value={all} onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '')
            setAll(v)
            setVals(Object.fromEntries(lines.map((l) => [l.key, v])))
          }} />
        </label>
      </div>
      <ul className="space-y-2">
        {lines.map((l) => {
          const p = catalog.bySku.get(l.sku)
          return (
            <li key={l.key} className="flex items-center justify-between gap-2">
              <span className="min-w-0 text-sm font-semibold text-stone-800">{p ? productLabel(p) : l.sku}</span>
              <Input className="w-24 shrink-0 text-center" inputMode="numeric" value={vals[l.key] ?? ''} onChange={(e) => setVals({ ...vals, [l.key]: e.target.value.replace(/\D/g, '') })} />
            </li>
          )
        })}
      </ul>
      <Button className="w-full" onClick={() => onAnswer(Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, v ? Number(v) : null])))}>Next</Button>
    </div>
  )
}

function CustomerQuestion({ an, draft, onAnswer }: { an: Analysis; draft: Draft; onAnswer: (choice: { id: string; alias?: string } | { newName: string }) => void }) {
  const [list, setList] = useState<CustomerLite[]>([])
  const [q, setQ] = useState('')
  const [newName, setNewName] = useState(an.names[0] ?? '')
  const [showNew, setShowNew] = useState(!an.guess.matches.length && !!an.read)
  useEffect(() => { loadCustomersLite().then((c) => setList(c.list.filter((x) => x.active))) }, [])
  const hits = useMemo(() => {
    const qn = norm(q)
    if (qn.length < 2) return []
    const digits = q.replace(/\D/g, '')
    return list.filter((c) => norm(`${c.name} ${c.code} ${c.billing_city ?? ''}`).includes(qn) || (digits.length >= 5 && (c.phone ?? '').includes(digits)) || (qn.length >= 4 && nameSimilarity(q, c.name) >= 0.7)).slice(0, 8)
  }, [list, q])
  const row = (c: CustomerLite, why?: string, alias?: string) => (
    <button key={c.id} type="button" className={`${BIG} border-stone-200 bg-white`} onClick={() => onAnswer({ id: c.id, alias })}>
      {c.name}<div className="text-sm font-normal text-stone-500">{[c.code, c.billing_city, c.default_channel, why].filter(Boolean).join(' · ')}</div>
    </button>
  )
  return (
    <div className="space-y-3">
      {an.guess.matches.length > 0 ? (
        <>
          <p className="text-lg text-stone-800">{an.guess.matches.length === 1 ? 'Is this the customer?' : 'Which customer is it?'}</p>
          {an.guess.matches.map((m) => row(m.c, m.why, an.guess.nameLine ?? undefined))}
        </>
      ) : <p className="text-lg text-stone-800">Who is the customer?</p>}
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search saved customers: name, phone, code…" autoFocus={!an.guess.matches.length} />
      {hits.map((c) => row(c, undefined, an.names.find((n) => norm(n) !== norm(c.name) && nameSimilarity(n, c.name) >= 0.5)))}
      {!showNew ? (
        <Button tone="plain" className="w-full" onClick={() => setShowNew(true)}>No, it’s a new customer</Button>
      ) : (
        <Card className="space-y-2 bg-ae-cream/50">
          <p className="text-sm font-semibold text-stone-700">New customer: name</p>
          {an.names.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {an.names.map((n) => <button key={n} type="button" onClick={() => setNewName(n)} className={`rounded-full border px-3 py-1.5 text-sm ${newName === n ? 'border-ae-blue bg-ae-blue text-ae-cream' : 'border-stone-300 bg-white'}`}>{n}</button>)}
            </div>
          )}
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Company or store name" />
          <Button className="w-full" disabled={!newName.trim()} onClick={() => onAnswer({ newName: newName.trim() })}>Add as a new customer</Button>
        </Card>
      )}
      {draft.customer_id && <p className="text-xs text-stone-500">Currently: {draft.customer_name}</p>}
    </div>
  )
}

type Label = 'billing' | 'delivery' | null

function AddressQuestion({ read, draft, onAnswer }: { read: ReadMessage; draft: Draft; onAnswer: (labels: Record<number, Label>, same: boolean) => void }) {
  const candidates = useMemo(() => [...read.addressLines].sort((a, b) => a - b), [read])
  const [labels, setLabels] = useState<Record<number, Label>>(() => {
    const out: Record<number, Label> = {}
    const { billingStart: b, deliveryStart: dl } = read
    // Group into blocks of neighbouring lines.
    const blocks: number[][] = []
    for (const i of candidates) {
      const last = blocks[blocks.length - 1]
      if (last && i - last[last.length - 1] <= 2) last.push(i)
      else blocks.push([i])
    }
    for (const blk of blocks) {
      let lab: Label
      if (b != null || dl != null) {
        const first = blk[0]
        lab = dl != null && first > dl && (b == null || dl > b || first < b) ? 'delivery' : b != null && first > b ? 'billing' : 'delivery'
      } else if (blocks.length >= 2) {
        // Two addresses without headings: the one with the GSTIN under it is the billing address.
        const gstLine = read.lines.findIndex((l) => read.gstins.some((g) => l.toUpperCase().includes(g)))
        const near = gstLine >= 0 && gstLine - blk[blk.length - 1] >= 0 && gstLine - blk[blk.length - 1] <= 4
        lab = near ? 'billing' : 'delivery'
      } else {
        lab = draft.customer_id && draft.billing_address ? 'delivery' : 'billing'
      }
      for (const i of blk) out[i] = lab
    }
    return out
  })
  const [mode, setMode] = useState<Label>('billing')
  const [same, setSame] = useState(() => !Object.values(labels).includes('delivery') && !(draft.customer_id && draft.billing_address))
  const lines = (lab: Label) => candidates.filter((i) => labels[i] === lab).map((i) => read.lines[i])
  const bill = splitAddress(lines('billing'), true)
  const del = splitAddress(lines('delivery'), true)
  const tone = (lab: Label) => (lab === 'billing' ? 'border-sky-500 bg-sky-50' : lab === 'delivery' ? 'border-green-600 bg-green-50' : 'border-stone-200 bg-white text-stone-400 line-through')
  return (
    <div className="space-y-3">
      <p className="text-lg text-stone-800">Which lines are the address? <span className="text-sm text-stone-500">Choose a colour, then tap lines.</span></p>
      <div className="grid grid-cols-3 gap-2 text-sm font-semibold">
        {([['billing', 'Billing', 'bg-sky-600'], ['delivery', 'Delivery', 'bg-green-700'], [null, 'Not address', 'bg-stone-500']] as [Label, string, string][]).map(([k, l, c]) => (
          <button key={l} type="button" onClick={() => setMode(k)} className={`min-h-11 rounded-lg px-2 ${mode === k ? `${c} text-white` : 'border border-stone-300 bg-white text-stone-700'}`}>{l}</button>
        ))}
      </div>
      <div className="space-y-1.5">
        {candidates.map((i) => (
          <button key={i} type="button" onClick={() => setLabels({ ...labels, [i]: labels[i] === mode ? null : mode })} className={`block w-full rounded-lg border-2 px-3 py-2 text-left text-sm ${tone(labels[i] ?? null)}`}>
            {read.lines[i]}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm font-semibold text-stone-700">
        <input type="checkbox" className="h-5 w-5" checked={same} onChange={(e) => setSame(e.target.checked)} /> Deliver to the billing address
      </label>
      <div className="grid gap-2 text-xs text-stone-600 sm:grid-cols-2">
        {bill.address && <div><b className="text-sky-700">Billing:</b> {[bill.name, bill.address].filter(Boolean).join(' — ')}</div>}
        {!same && del.address && <div><b className="text-green-700">Delivery:</b> {[del.name, del.address].filter(Boolean).join(' — ')}</div>}
      </div>
      <Button className="w-full" onClick={() => onAnswer(labels, same)}>Next</Button>
    </div>
  )
}

function ChoiceQuestion({ title, choices, hints = {}, onAnswer }: { title: string; choices: readonly string[]; hints?: Record<string, string>; onAnswer: (c: string) => void }) {
  return (
    <div className="space-y-3">
      <p className="text-lg text-stone-800">{title}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {choices.map((c) => (
          <button key={c} type="button" className={`${BIG} border-stone-200 bg-white text-stone-800`} onClick={() => onAnswer(c)}>
            {c}{hints[c] && <div className="text-sm font-normal text-stone-500">{hints[c]}</div>}
          </button>
        ))}
      </div>
    </div>
  )
}

function MarginQuestion({ found, onAnswer }: { found: number | null; onAnswer: (m: number | null | 'rate' | 'foc') => void }) {
  const [v, setV] = useState(found != null ? String(found) : '')
  return (
    <div className="space-y-3">
      <p className="text-lg text-stone-800">{found != null ? <>Margin? The message says <b>{found}%</b>.</> : 'What margin does this customer get?'}</p>
      {found != null && <Button className="w-full" onClick={() => onAnswer(found)}>Yes, {found}%</Button>}
      <div className="flex flex-wrap gap-2">
        {[0, 25, 30, 35, 40, 50].filter((m) => m !== found).map((m) => (
          <button key={m} type="button" className="min-h-11 rounded-lg border border-stone-300 bg-white px-4 font-semibold" onClick={() => onAnswer(m)}>{m === 0 ? 'Full MRP' : `${m}%`}</button>
        ))}
      </div>
      <div className="flex gap-2">
        <Input inputMode="decimal" value={v} onChange={(e) => setV(e.target.value.replace(/[^\d.]/g, ''))} placeholder="Other %" />
        <Button tone="plain" disabled={!v} onClick={() => onAnswer(Number(v))}>Use</Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Button tone="plain" onClick={() => onAnswer('rate')}>Agreed price per pack instead</Button>
        <Button tone="plain" onClick={() => onAnswer(null)}>Don’t know yet</Button>
      </div>
    </div>
  )
}

function PoQuestion({ onAnswer }: { onAnswer: (po: string, date: string) => void }) {
  const [po, setPo] = useState('')
  const [date, setDate] = useState('')
  return (
    <div className="space-y-3">
      <p className="text-lg text-stone-800">PO number and date?</p>
      <Input value={po} onChange={(e) => setPo(e.target.value)} placeholder="PO number" />
      <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <div className="flex gap-2">
        <Button tone="plain" onClick={() => onAnswer('', '')}>Don’t have it yet</Button>
        <Button className="flex-1" disabled={!po.trim()} onClick={() => onAnswer(po.trim(), date)}>Next</Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- the page

export default function NewOrder() {
  const { me } = useAuth()
  const { catalog } = useCatalog()
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(me?.id ?? null))
  const [step, setStep] = useState<'input' | 'questions' | 'review'>('input')
  const [an, setAn] = useState<Analysis | null>(null)
  const [queue, setQueue] = useState<Q[]>([])
  const [at, setAt] = useState(0)
  const [asked, setAsked] = useState(0)
  const [info, setInfo] = useState('')

  const basis = (d: Draft) => (d.channel === 'FOC' ? 'foc' : d.margin_pct != null ? 'mrp_minus_margin' : null)

  const start = async (text: string, files: File[], source: string, sheetItems?: PoItem[]) => {
    const cat = catalog ?? (await loadCatalog())
    const team = (await supabase.from('people').select('name')).data?.map((p) => p.name) ?? []
    const read = readMessage(text, team)
    // A PO: item rows from the Excel table, or barcode rows in the PDF; otherwise the message's lines.
    const poRows: PoItem[] = sheetItems?.length ? sheetItems : source === 'po_file' ? readBarcodeRows(read.lines) : []
    const byEan = (ean?: string) => {
      if (!ean) return undefined
      const e = ean.replace(/^0(?=\d{12}$)/, '')
      const sku = cat.products.find((p) => p.ean === e)?.sku ?? cat.aliases.find((a) => a.kind === 'ean' && a.alias === e)?.sku
      const p = sku ? cat.bySku.get(sku) : undefined
      return p?.replaced_by ? cat.bySku.get(p.replaced_by) : p
    }
    let items: ResolvedItem[]
    if (poRows.length) {
      items = poRows.map((si) => {
        const hit = byEan(si.ean)
        if (hit) return { raw: si, typed: si.text, qty: si.qty, sku: hit.sku, options: [hit], sure: true }
        return resolveItems(cat, [{ ...si, qty: si.qty ?? 1 }]).map((r) => ({ ...r, qty: si.qty }))[0]
          ?? { raw: si, typed: si.text, qty: si.qty, sku: null, options: searchProducts(cat, si.text, { offlineOnly: true, limit: 3 }), sure: false }
      })
    } else {
      items = resolveItems(cat, read.items)
    }
    const { list, aliases } = await loadCustomersLite()
    const guess = resolveCustomer(list, aliases, read)
    const names = guessCustomerNames(read.lines, read.addressLines, read.billingStart, new Set(items.map((i) => i.raw.line)), read.deliveryStart)
    const analysis: Analysis = { read, items, guess, names }

    // Details the message states outright go straight in.
    let d: Draft = {
      ...emptyDraft(me?.id ?? null), source, source_text: text, files,
      phone: read.phones[0] ?? '', email: read.emails[0] ?? '', fssai: read.fssai ?? '',
      gstin: read.gstins[0] ?? '', gst_status: read.gstins[0] ? 'registered' : '', billing_state: stateFromGstin(read.gstins[0] ?? ''),
      po_number: read.poNumbers[0] ?? '', margin_pct: read.margin,
    }
    d.lines = items.filter((i) => i.sure && i.sku).map((i) => poLine(cat, i, i.sku!, i.qty))
    if (guess.sure) d = await applyCustomer({ ...d, learn_customer_alias: guess.nameLine }, guess.matches[0].c.id)

    const qs: Q[] = []
    if (!guess.sure) qs.push({ kind: 'customer' })
    for (const it of items.filter((i) => !i.sure)) qs.push({ kind: 'product', item: it })
    qs.push({ kind: 'qty' }, { kind: 'address' }, { kind: 'channel' }, { kind: 'margin' }, { kind: 'po' })
    setAn(analysis)
    setDraft(d)
    setQueue(qs)
    setAt(0)
    setAsked(0)
    setInfo(guess.sure ? `Customer found: ${guess.matches[0].c.name} (${guess.matches[0].why}).` : '')
    setStep('questions')
  }

  const startBlank = () => {
    setAn({ read: null, items: [], guess: { matches: [], sure: false, nameLine: null }, names: [] })
    setDraft(emptyDraft(me?.id ?? null))
    setQueue([{ kind: 'customer' }, { kind: 'channel' }])
    setAt(0)
    setAsked(0)
    setStep('questions')
  }

  /** Is this question still worth asking, given the answers so far? */
  const relevant = (q: Q, d: Draft): boolean => {
    switch (q.kind) {
      case 'qty': return d.lines.some((l) => !l.qty)
      case 'address': return !!an?.read && an.read.addressLines.size > 0
      case 'channel': return !d.channel
      case 'margin': return !!an?.read && d.channel !== 'FOC' && d.lines.some((l) => !l.price_basis) && (d.margin_pct == null || an.read.margin != null)
      case 'po': return false // no PO from the party: the Hub makes its own PO number
      default: return true
    }
  }

  // Skip questions that the answers so far have made unnecessary.
  useEffect(() => {
    if (step !== 'questions') return
    let i = at
    while (i < queue.length && !relevant(queue[i], draft)) i++
    if (i >= queue.length) {
      setDraft((d) => ({ ...d, lines: d.lines.map((l) => (l.price_basis ? l : { ...l, price_basis: basis(d), margin_pct: d.margin_pct })) }))
      setStep('review')
    } else if (i !== at) setAt(i)
  }, [step, at, queue, draft]) // eslint-disable-line react-hooks/exhaustive-deps

  const next = (d: Draft) => {
    setDraft(d)
    setAsked((n) => n + 1)
    setAt((i) => i + 1)
  }

  if (!catalog) return <p className="text-sm text-stone-500">Loading products…</p>

  if (step === 'input') {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <div>
          <h2 className="text-xl font-bold text-ae-blue">New order</h2>
          <p className="text-sm text-stone-600">Give the order as you got it. The Hub reads it and only asks what it isn’t sure about.</p>
        </div>
        <InputStep onRead={start} onBlank={startBlank} />
      </div>
    )
  }

  if (step === 'review') {
    return (
      <div className="space-y-3">
        <div>
          <h2 className="text-xl font-bold text-ae-blue">Check and save</h2>
          {an?.read && <p className="text-sm text-stone-600">Read from the {draft.source === 'paste' ? 'message' : draft.source === 'screenshot' ? 'picture' : 'PO'}: {draft.lines.length} products, {asked} {asked === 1 ? 'question' : 'questions'} asked.</p>}
        </div>
        <OrderReview draft={draft} setDraft={setDraft} onBack={() => { setStep('input'); setDraft(emptyDraft(me?.id ?? null)) }} />
      </div>
    )
  }

  const q = queue[at]
  if (!q || !an) return null
  const remaining = queue.slice(at).filter((x) => relevant(x, draft)).length

  return (
    <div className="mx-auto max-w-xl space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-ae-blue">A few questions</h2>
        <Badge>{remaining} left at most</Badge>
      </div>
      <OkBox>{info}</OkBox>
      {draft.lines.length > 0 && (
        <p className="text-sm text-stone-600">Already understood: {draft.lines.map((l) => `${l.qty ?? '?'} × ${productLabel(catalog.bySku.get(l.sku)!)}`).join('; ')}</p>
      )}
      <Card>
        {q.kind === 'customer' && (
          <CustomerQuestion an={an} draft={draft} onAnswer={async (c) => {
            if ('id' in c) next(await applyCustomer({ ...draft, learn_customer_alias: c.alias ?? null }, c.id))
            else next({ ...draft, customer_id: null, customer_name: c.newName })
            setInfo('')
          }} />
        )}
        {q.kind === 'product' && (
          <ProductQuestion key={q.item.raw.text + at} item={q.item} catalog={catalog} onAnswer={(sku, qty) => {
            if (!sku) return next(draft)
            const existing = draft.lines.find((l) => l.sku === sku)
            const lines = existing
              ? draft.lines.map((l) => (l === existing ? { ...l, qty: (l.qty ?? 0) + (qty ?? 0) || null } : l))
              : [...draft.lines, { ...poLine(catalog, q.item, sku, qty), learn: tidy(q.item.typed).length > 2 }]
            next({ ...draft, lines })
          }} />
        )}
        {q.kind === 'qty' && (
          <QtyQuestion lines={draft.lines.filter((l) => !l.qty)} catalog={catalog} onAnswer={(vals) => next({ ...draft, lines: draft.lines.map((l) => (l.key in vals ? { ...l, qty: vals[l.key] } : l)) })} />
        )}
        {q.kind === 'address' && an.read && (
          <AddressQuestion read={an.read} draft={draft} onAnswer={(labels, same) => {
            const ls = (lab: Label) => [...an.read!.addressLines].sort((a, b) => a - b).filter((i) => labels[i] === lab).map((i) => an.read!.lines[i])
            const b = splitAddress(ls('billing'), true)
            const dl = splitAddress(ls('delivery'), true)
            const d = { ...draft, same_as_billing: same }
            if (b.address) Object.assign(d, { billing_address: b.address, billing_city: b.city || d.billing_city, billing_state: b.state || d.billing_state || stateFromGstin(d.gstin), billing_pin: b.pin || d.billing_pin })
            if (!d.customer_id && b.name && !d.customer_name) d.customer_name = b.name
            if (!same && dl.address) Object.assign(d, { address_id: null, delivery_name: dl.name || d.customer_name, delivery_address: dl.address, delivery_city: dl.city, delivery_state: dl.state, delivery_pin: dl.pin })
            next(d)
          }} />
        )}
        {q.kind === 'channel' && (
          <ChoiceQuestion title="Which channel is this order for?" choices={CHANNELS} hints={CHANNEL_HINT} onAnswer={(c) => next({ ...draft, channel: c })} />
        )}
        {q.kind === 'margin' && (
          <MarginQuestion found={an.read?.margin ?? draft.margin_pct} onAnswer={(m) => {
            if (m === 'rate') next({ ...draft, lines: draft.lines.map((l) => ({ ...l, price_basis: l.price_basis ?? 'agreed_rate' })) })
            else if (m === 'foc') next({ ...draft, lines: draft.lines.map((l) => ({ ...l, price_basis: 'foc' })) })
            else next({ ...draft, margin_pct: m, lines: draft.lines.map((l) => (l.price_basis ? l : { ...l, price_basis: m == null ? null : 'mrp_minus_margin', margin_pct: m })) })
          }} />
        )}
        {q.kind === 'po' && <PoQuestion onAnswer={(po, date) => next({ ...draft, po_number: po, po_date: date })} />}
      </Card>
      <div className="flex justify-between">
        <button type="button" className="text-sm text-stone-600 underline" onClick={() => setStep('input')}>Start again</button>
        <button type="button" className="text-sm font-semibold text-ae-blue underline" onClick={() => setAt(queue.length)}>Skip to the summary</button>
      </div>
    </div>
  )
}
