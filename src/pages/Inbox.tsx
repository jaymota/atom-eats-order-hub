// "To confirm": POs that came by email to sales@atomconsulting.in, GRNs to attach to their order,
// and emails from senders we don't know.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Badge, Button, Card, ErrorBox, Input, OkBox } from '../components/ui'
import { useAuth } from '../lib/auth'
import { ago, isAdmin } from '../lib/format'
import { supabase } from '../lib/supabase'
import { todoChanged } from '../lib/todo'
import { age, can } from '../lib/stages'
import { itemsShort } from './Orders'

interface Mail {
  id: string; from_addr: string; from_name: string | null; subject: string; received_at: string; body_text: string | null
  source: string | null; kind: 'po' | 'revised' | 'grn' | 'other'; status: 'new' | 'done' | 'ignored'; order_id: string | null; note: string | null
  inbox_files: { id: string; path: string; name: string }[]
}
interface OrderRef { id: string; order_no: string; po_number: string | null; customer_name: string; stage: string }
interface Sender { id: number; match: string; source: string; active: boolean }
interface SalesOrder { id: string; order_no: string; customer_name: string; received_at: string; salesperson: { name: string } | null; order_lines: { product_name: string | null; qty: number }[] }

const SOURCE: Record<string, string> = { blinkit: 'Blinkit', foodstories: 'Foodstories', foodsquare: 'Food Square', forwarded: 'Forwarded' }
const TABS = [['sales', 'Sales'], ['po', 'POs'], ['grn', 'GRN'], ['other', 'Other'], ['done', 'Done']] as const

export default function Inbox() {
  const { me } = useAuth()
  const navigate = useNavigate()
  const [mails, setMails] = useState<Mail[] | null>(null)
  const [orders, setOrders] = useState<OrderRef[]>([])
  const [senders, setSenders] = useState<Sender[]>([])
  const [sales, setSales] = useState<SalesOrder[]>([])
  const [checked, setChecked] = useState<string | null>(null)
  const [tab, setTab] = useState<string>('')
  const [pick, setPick] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [add, setAdd] = useState({ match: '', source: '' })

  const load = useCallback(async () => {
    const [m, o, s, so, st] = await Promise.all([
      supabase.from('inbox_emails').select('id, from_addr, from_name, subject, received_at, body_text, source, kind, status, order_id, note, inbox_files(id, path, name)')
        .order('received_at', { ascending: false }).limit(300),
      supabase.from('orders').select('id, order_no, po_number, customer_name, stage').not('po_number', 'is', null).order('created_at', { ascending: false }).limit(1000),
      supabase.from('inbox_senders').select('*').order('source'),
      supabase.from('orders').select('id, order_no, customer_name, received_at, salesperson:people!orders_salesperson_id_fkey(name), order_lines(product_name, qty)').eq('stage', 'sales_order').order('received_at'),
      supabase.from('inbox_status').select('last_check_at').maybeSingle(),
    ])
    setChecked(st.data?.last_check_at ?? null)
    setSales((so.data ?? []) as unknown as SalesOrder[])
    // Open on the first tab that has something waiting.
    setTab((t) => t || ((so.data ?? []).length ? 'sales' : 'po'))
    setMails((m.data ?? []) as Mail[])
    setOrders((o.data ?? []) as OrderRef[])
    setSenders((s.data ?? []) as Sender[])
    todoChanged()
  }, [])
  useEffect(() => { load() }, [load])

  const inTab = (m: Mail) => (tab === 'done' ? m.status !== 'new' : m.status === 'new' && (tab === 'po' ? ['po', 'revised'].includes(m.kind) : m.kind === tab))
  const list = useMemo(() => (mails ?? []).filter(inTab), [mails, tab]) // eslint-disable-line react-hooks/exhaustive-deps
  const count = (k: string) => k === 'sales' ? sales.length : (mails ?? []).filter((m) => m.status === 'new' && (k === 'po' ? ['po', 'revised'].includes(m.kind) : m.kind === k)).length

  /** Orders whose PO number appears in the email's subject or text (GRNs, revised POs). */
  const matches = (m: Mail) => {
    const hay = `${m.subject} ${m.body_text ?? ''}`
    return orders.filter((o) => o.po_number && o.po_number.length >= 4 && !o.po_number.startsWith('AE-PO') && hay.includes(o.po_number)).slice(0, 3)
  }

  const open = async (path: string) => {
    const { data } = await supabase.storage.from('order-files').createSignedUrl(path, 600)
    if (data) window.open(data.signedUrl, '_blank')
  }
  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string) => {
    setError(''); setMsg('')
    const { error: e } = await fn()
    if (e) setError(e.message)
    else { setMsg(ok); load() }
  }
  const attach = (m: Mail, o: OrderRef) => run(() => supabase.rpc('inbox_done', { p_email: m.id, p_order: o.id }), `Attached to ${o.order_no}.`)
  const attachTyped = (m: Mail) => {
    const t = (pick[m.id] ?? '').trim().toUpperCase()
    const o = orders.find((x) => x.order_no === t || x.po_number?.toUpperCase() === t)
    if (!o) { setError(`No order with number or PO ${t}.`); return }
    attach(m, o)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-xl font-bold text-ae-blue">To confirm</h2>
        {/* The Gmail script checks sales@ every 15 minutes; red when it hasn't for 30+ minutes. */}
        <span className={`text-xs ${!checked || Date.now() - Date.parse(checked) > 30 * 60_000 ? 'font-semibold text-red-700' : 'text-stone-500'}`}>
          {checked ? `Mail checked ${ago(checked)}` : 'Mail not checked yet'}
        </span>
      </div>
      <div className="flex rounded-xl border border-ae-blue/20 bg-white p-1">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={`min-h-11 flex-1 rounded-lg px-2 text-sm font-semibold ${tab === k ? 'bg-ae-blue text-ae-cream' : 'text-stone-600'}`}>
            {label}{k !== 'done' && mails ? ` (${count(k)})` : ''}
          </button>
        ))}
      </div>
      <OkBox>{msg}</OkBox>
      <ErrorBox>{error}</ErrorBox>

      {tab === 'sales' ? (
        !sales.length ? <Card><p className="text-stone-600">No sales orders waiting.</p></Card> : (
          <ul className="space-y-2">
            {sales.map((s) => (
              <li key={s.id}>
                <Card className="space-y-1 p-3 sm:p-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold text-stone-900">{s.customer_name}</span>
                    <span className="text-xs text-stone-500">{age(s.received_at)}</span>
                  </div>
                  <div className="text-xs text-stone-500">{s.order_no}{s.salesperson && ` · by ${s.salesperson.name}`}</div>
                  <div className="text-sm text-stone-700">{itemsShort(s.order_lines)}</div>
                  <div className="pt-1">
                    {can.plan(me?.role)
                      ? <Button onClick={() => navigate(`/orders/${s.id}`, { state: { complete: true } })}>Complete</Button>
                      : <Link to={`/orders/${s.id}`} className="font-semibold text-ae-blue underline">Open</Link>}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )
      ) : !mails ? <p className="text-sm text-stone-500">Loading…</p> : !list.length ? <Card><p className="text-stone-600">Nothing here.</p></Card> : (
        <ul className="space-y-2">
          {list.map((m) => {
            const found = m.kind !== 'po' || m.status !== 'new' ? matches(m) : []
            return (
              <li key={m.id}>
                <Card className="space-y-2 p-3 sm:p-4">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={m.source ? 'green' : 'amber'}>{SOURCE[m.source ?? ''] ?? (m.source || 'Unknown sender')}</Badge>
                    {m.kind === 'revised' && <Badge tone="amber">Revised</Badge>}
                    {m.kind === 'grn' && <Badge>GRN</Badge>}
                    <span className="text-xs text-stone-500">{ago(m.received_at)}</span>
                  </div>
                  <div className="font-semibold text-stone-900">{m.subject || '(no subject)'}</div>
                  <div className="text-xs text-stone-500">{m.from_name ? `${m.from_name} · ` : ''}{m.from_addr}</div>
                  <div className="flex flex-wrap gap-2">
                    {m.inbox_files.map((f) => <button key={f.id} type="button" onClick={() => open(f.path)} className="rounded-lg border px-2 py-1 text-sm text-ae-blue underline">📎 {f.name}</button>)}
                    {!m.inbox_files.length && <span className="text-xs text-stone-500">No files</span>}
                  </div>

                  {m.status === 'new' ? (
                    m.kind === 'grn' ? (
                      <div className="space-y-2">
                        {found.map((o) => <Button key={o.id} className="mr-2" onClick={() => attach(m, o)}>Attach to {o.order_no} · {o.customer_name}</Button>)}
                        <div className="flex gap-2">
                          <Input className="min-h-10 text-sm" placeholder="Order no. or PO no." value={pick[m.id] ?? ''} onChange={(e) => setPick({ ...pick, [m.id]: e.target.value })} />
                          <Button tone="plain" className="min-h-10 px-3 text-sm" disabled={!pick[m.id]?.trim()} onClick={() => attachTyped(m)}>Attach</Button>
                        </div>
                        <button type="button" className="text-sm text-stone-500 underline" onClick={() => run(() => supabase.rpc('inbox_ignore', { p_email: m.id }), 'Ignored.')}>Ignore</button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button disabled={!m.inbox_files.length} onClick={() => navigate('/orders/new', { state: { inboxId: m.id } })}>Make order</Button>
                        {found.map((o) => <Button key={o.id} tone="plain" onClick={() => attach(m, o)}>Add to {o.order_no}</Button>)}
                        <button type="button" className="text-sm text-stone-500 underline" onClick={() => run(() => supabase.rpc('inbox_ignore', { p_email: m.id }), 'Ignored.')}>Ignore</button>
                      </div>
                    )
                  ) : (
                    <div className="text-sm text-stone-600">
                      {m.status === 'done' && m.order_id ? <Link to={`/orders/${m.order_id}`} className="font-semibold text-ae-blue underline">Open order</Link> : 'Ignored'}
                      {m.status === 'ignored' && <button type="button" className="ml-3 underline" onClick={() => run(() => supabase.rpc('inbox_ignore', { p_email: m.id, p_undo: true }), 'Back in the list.')}>Undo</button>}
                    </div>
                  )}
                </Card>
              </li>
            )
          })}
        </ul>
      )}

      {isAdmin(me?.role) && tab === 'other' && (
        <Card className="space-y-2">
          <h3 className="font-semibold text-ae-blue">Known PO senders</h3>
          <ul className="text-sm">
            {senders.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 py-1">
                <span className={s.active ? '' : 'text-stone-400 line-through'}><span className="font-mono">{s.match}</span> → {SOURCE[s.source] ?? s.source}</span>
                <button type="button" className="text-xs underline" onClick={() => run(() => supabase.rpc('save_inbox_sender', { p_match: s.match, p_source: s.source, p_active: !s.active }), 'Saved.')}>{s.active ? 'Turn off' : 'Turn on'}</button>
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Input placeholder="Email or domain" value={add.match} onChange={(e) => setAdd({ ...add, match: e.target.value })} />
            <Input placeholder="Name, e.g. istore" value={add.source} onChange={(e) => setAdd({ ...add, source: e.target.value })} />
            <Button tone="plain" disabled={!add.match.trim() || !add.source.trim()} onClick={() => run(() => supabase.rpc('save_inbox_sender', { p_match: add.match, p_source: add.source }), 'Sender added.').then(() => setAdd({ match: '', source: '' }))}>Add</Button>
          </div>
        </Card>
      )}
    </div>
  )
}
