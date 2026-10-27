// Hand-off emails: ops → accounts when orders are planned, accounts → ops when invoices are
// recorded, and a copy of each (plus dispatches) to whoever has "copy on hand-offs" (Siddhesh).
// The browser calls this after a stage change; it only sends about orders that really are at that stage.
//
// Body: { kind: 'planned' | 'invoiced' | 'dispatched', ids: string[] }
import { SITE_URL, adminDb, cors, emailLayout, escapeHtml, getCaller, json, rateLimit, sendEmail } from '../_shared/server.ts'

const KINDS = {
  planned: { stage: 'planned', to: 'accounts', subject: (n: number) => `${n} order${n === 1 ? '' : 's'} to invoice`, line: 'Planned for dispatch. Please make the invoice.' },
  invoiced: { stage: 'invoiced', to: 'ops', subject: (n: number) => `${n} invoice${n === 1 ? '' : 's'} ready — dispatch`, line: 'Invoice shared. Ready to dispatch.' },
  dispatched: { stage: 'dispatched', to: null, subject: (n: number) => `${n} order${n === 1 ? '' : 's'} dispatched`, line: 'Dispatched.' },
} as const

const inr = (n: number | null) => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) })
  if (req.method !== 'POST') return json(req, { error: 'Not allowed' }, 405)
  const db = adminDb()
  const me = await getCaller(req, db)
  if (!me || me.must_change_pin) return json(req, { error: 'Please log in again.' }, 401)

  let body: { kind?: string; ids?: unknown } = {}
  try { body = await req.json() } catch { /* empty */ }
  const k = KINDS[body.kind as keyof typeof KINDS]
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 200) : []
  if (!k || !ids.length) return json(req, { error: 'Nothing to send.' }, 400)
  if (!(await rateLimit(db, `notify:${me.id}`, 30, 60))) return json(req, { error: 'Too many emails. Try later.' }, 429)

  const { data: orders } = await db.from('orders')
    .select('id, order_no, customer_name, channel, delivery_city, billing_city, estimate_value, invoice_no, invoice_value, courier, tracking_no')
    .in('id', ids).eq('stage', k.stage).order('order_no')
  if (!orders?.length) return json(req, { ok: true, sent: 0 })

  let q = db.from('people').select('email, role, copy_on_handoffs').eq('active', true)
  q = k.to ? q.or(`role.eq.${k.to},copy_on_handoffs.eq.true`) : q.eq('copy_on_handoffs', true)
  const { data: people } = await q
  const to = (people ?? []).map((p) => p.email as string).filter(Boolean)

  const rows = orders.map((o) => {
    const extra = k.stage === 'planned' ? inr(o.estimate_value) + ' est.'
      : k.stage === 'invoiced' ? `${escapeHtml(o.invoice_no ?? '')} · ${inr(o.invoice_value)}`
      : `${escapeHtml(o.courier ?? '')} ${escapeHtml(o.tracking_no ?? '')}`
    return `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee"><a href="${SITE_URL}/#/orders/${o.id}" style="color:#324298;font-weight:600">${escapeHtml(o.order_no)}</a></td>
<td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(o.customer_name)}<br><span style="color:#777;font-size:13px">${escapeHtml(o.channel)} · ${escapeHtml(o.delivery_city ?? o.billing_city ?? '')}</span></td>
<td style="padding:6px 8px;border-bottom:1px solid #eee;white-space:nowrap">${extra}</td></tr>`
  }).join('')
  const html = emailLayout(k.subject(orders.length),
    `<p>${escapeHtml(me.name)}: ${k.line}</p><table cellpadding="0" cellspacing="0" style="width:100%;font-size:14px">${rows}</table>
<p><a href="${SITE_URL}" style="display:inline-block;background:#324298;color:#fff1d6;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Open the Hub</a></p>`)
  const res = await sendEmail({ to, subject: k.subject(orders.length), html })
  return json(req, { ok: res.ok, sent: res.ok ? to.length : 0, error: res.error })
})
