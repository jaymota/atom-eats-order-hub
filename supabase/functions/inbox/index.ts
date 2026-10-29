// Receives emails from the Google Apps Script running inside sales@atomconsulting.in.
// Only that script knows INBOX_KEY. Each email is kept once (by its Gmail id), sorted into
// PO / revised PO / GRN / other, and its attachments are put in the private file store.
//
// Body: { id, threadId, from, fromName, subject, date, body, attachments: [{ name, mime, data (base64) }] }
import { adminDb, json } from '../_shared/server.ts'

const OK_FILE = /\.(pdf|xlsx?|csv|png|jpe?g|webp)$/i
const MAX_FILE = 10 * 1024 * 1024

function sameKey(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(req, { error: 'Not allowed' }, 405)
  if (!sameKey(req.headers.get('x-hub-key') ?? '', Deno.env.get('INBOX_KEY') ?? '')) return json(req, { error: 'Not allowed' }, 403)

  let m: Record<string, unknown>
  try { m = await req.json() } catch { return json(req, { error: 'Bad email' }, 400) }
  const gmailId = String(m.id ?? '')
  const from = String(m.from ?? '').toLowerCase().trim()
  if (!gmailId || !from) return json(req, { error: 'Bad email' }, 400)
  const subject = String(m.subject ?? '').slice(0, 500)
  const body = String(m.body ?? '').slice(0, 20000)

  const db = adminDb()
  const { data: seen } = await db.from('inbox_emails').select('id').eq('gmail_id', gmailId).maybeSingle()
  if (seen) return json(req, { ok: true, duplicate: true })

  // Who sent it: a known PO sender, a team member forwarding one, or someone we don't know.
  const { data: senders } = await db.from('inbox_senders').select('match, source').eq('active', true)
  const known = (text: string) => (senders ?? []).find((s) => text.includes(s.match))?.source ?? null
  let source = known(from)
  if (!source) {
    const { data: team } = await db.from('people').select('email').eq('active', true)
    const teamEmails = new Set((team ?? []).map((p) => String(p.email ?? '').toLowerCase()).filter(Boolean))
    if (teamEmails.has(from) || /@(atomconsulting\.in|atomeats\.com)$/.test(from)) {
      source = known(body.toLowerCase()) ?? 'forwarded' // "---------- Forwarded message --------- From: ordering@partnersbiz.com"
    }
  }
  // Payment advice, statements, credit / debit notes are not orders, even from a PO sender.
  const fileNames = (Array.isArray(m.attachments) ? m.attachments : []).map((a: { name?: string }) => String(a.name ?? '')).join(' ')
  const notOrder = /payment|remittance|statement|ledger|debit note|credit note|\bbill\b|advice/i.test(`${subject} ${fileNames}`) && !/purchase\s*order|\bP\.?O\b/i.test(subject)
  const kind = /\bGRN\b/i.test(subject) ? 'grn' : notOrder ? 'other' : /revised/i.test(subject) ? 'revised' : source ? 'po' : 'other'

  const { data: e, error } = await db.from('inbox_emails').insert({
    gmail_id: gmailId, thread_id: String(m.threadId ?? '') || null, from_addr: from, from_name: String(m.fromName ?? '').slice(0, 200) || null,
    subject, received_at: new Date(String(m.date ?? '')).toISOString(), body_text: body, source, kind,
  }).select('id').single()
  if (error) return json(req, { error: error.message }, 500)

  let files = 0
  for (const a of (Array.isArray(m.attachments) ? m.attachments : []).slice(0, 10) as { name?: string; mime?: string; data?: string }[]) {
    const name = String(a.name ?? 'file').slice(0, 120)
    if (!OK_FILE.test(name) || !a.data) continue
    const bytes = fromBase64(a.data)
    if (bytes.length > MAX_FILE) continue
    const path = `inbox/${e.id}/${Date.now()}-${name.replace(/[^\w.-]+/g, '-')}`
    const up = await db.storage.from('order-files').upload(path, bytes, { contentType: a.mime || undefined })
    if (up.error) continue
    await db.from('inbox_files').insert({ email_id: e.id, path, name, mime: a.mime ?? null, size_bytes: bytes.length })
    files++
  }
  return json(req, { ok: true, id: e.id, kind, source, files })
})
