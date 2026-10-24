// Helpers shared by the Edge Functions (server side only).
// Emails go out as Atom Eats (atomeats.com), never as Atom Consulting.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

export const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
export const SITE_URL = Deno.env.get('SITE_URL') ?? 'https://orders.atomeats.com'
const FROM_EMAIL = Deno.env.get('FROM_EMAIL') ?? 'Atom Eats Order Hub <orders@atomeats.com>'

const ALLOWED_ORIGINS = [
  'https://orders.atomeats.com',
  'http://localhost:5173',
  'http://localhost:5174',
]

export function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), 'Content-Type': 'application/json' },
  })
}

/** Full-access database client. Never expose this key to the browser. */
export function adminDb(): SupabaseClient {
  return createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** Normal (logged-out) client, used to turn a one-time link into a login session. */
export function anonDb(): SupabaseClient {
  return createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for') ?? ''
  return (fwd.split(',')[0] || req.headers.get('x-real-ip') || 'unknown').trim().slice(0, 64)
}

export function deviceLabel(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'device'
  return `${browser} on ${os}`
}

export function istNow(): string {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
}

export function istTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function randomCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000
  return String(n).padStart(6, '0')
}

/** Returns true if the bucket has fewer than `max` hits in the window (and records this hit). */
export async function rateLimit(db: SupabaseClient, bucket: string, max: number, windowMinutes: number): Promise<boolean> {
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString()
  const { count } = await db.from('rate_hits').select('id', { count: 'exact', head: true })
    .eq('bucket', bucket).gte('created_at', since)
  if ((count ?? 0) >= max) return false
  await db.from('rate_hits').insert({ bucket })
  return true
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

/** Plain branded email wrapper. `bodyHtml` must already be escaped. */
export function emailLayout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#fff1d6;font-family:Poppins,Arial,Helvetica,sans-serif;color:#1f2547">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fff1d6;padding:24px 0"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:8px;overflow:hidden">
<tr><td style="background:#324298;padding:14px 32px"><img src="https://atomeats.com/cdn/shop/files/AtomEats_Logo.png?v=1729704984&width=200" alt="Atom Eats" height="44" style="display:block;background:#fff1d6;border-radius:6px;padding:4px 8px"></td></tr>
<tr><td style="padding:24px 32px 28px;font-size:15px;line-height:1.6">
<div style="font-weight:700;color:#324298">Order Hub</div>
<h2 style="font-size:19px;margin:12px 0 16px;color:#324298">${escapeHtml(title)}</h2>${bodyHtml}
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #eee;font-size:12px;color:#777">${escapeHtml(SITE_URL)}</td></tr>
</table></td></tr></table></body></html>`
}

/** Sends an email through Resend. Quietly does nothing until the Resend key is added. */
export async function sendEmail(msg: { to: string[]; subject: string; html: string }): Promise<{ ok: boolean; error?: string }> {
  const key = Deno.env.get('RESEND_API_KEY')
  const to = [...new Set(msg.to.filter(Boolean).map((e) => e.toLowerCase()))]
  if (!key) {
    console.warn('RESEND_API_KEY not set — email not sent:', msg.subject)
    return { ok: false, error: 'Email is not set up yet.' }
  }
  if (!to.length) return { ok: false, error: 'No email address on file.' }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject: msg.subject, html: msg.html }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    console.error('Resend error', res.status, body)
    return { ok: false, error: body?.message ?? `Email failed (${res.status})` }
  }
  return { ok: true }
}

/** Email addresses of all active super admins (Jay). */
export async function superAdminEmails(db: SupabaseClient): Promise<string[]> {
  const { data } = await db.from('people').select('email').eq('role', 'super_admin').eq('active', true)
  return (data ?? []).map((r) => r.email as string).filter(Boolean)
}

export async function logActivity(
  db: SupabaseClient,
  personId: string | null,
  kind: string,
  summary: string,
  extra: { entity_type?: string; entity_id?: string; detail?: Record<string, unknown> } = {},
) {
  await db.from('activity').insert({ person_id: personId, kind, summary, ...extra })
}

export interface Caller {
  id: string
  name: string
  role: string
  active: boolean
  must_change_pin: boolean
}

/** Works out who is calling from their login token. Returns null if not logged in. */
export async function getCaller(req: Request, db: SupabaseClient): Promise<Caller | null> {
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return null
  const { data: u } = await db.auth.getUser(jwt)
  const uid = u.user?.id
  if (!uid) return null
  const { data: p } = await db.from('people').select('id, name, role, active, must_change_pin').eq('id', uid).maybeSingle()
  return p && p.active ? (p as Caller) : null
}
