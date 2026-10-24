// Managing the team: add people, change their details or role, reset PINs, switch people off.
// Admins manage everyone except admins; only the super admin manages admins.
//
// Actions: add, update, reset_pin, unlock
import bcrypt from 'npm:bcryptjs@2.4.3'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { SUPABASE_URL, adminDb, cors, json, logActivity } from '../_shared/server.ts'
import { ROLES, normaliseUsername, randomPin, type Role } from '../_shared/pin.ts'

const ROLE_NAMES: Record<Role, string> = {
  super_admin: 'Super admin', admin: 'Admin', accounts: 'Accounts', ops: 'Ops / dispatch', sales: 'Sales',
}
const isAdminRole = (r: string) => r === 'super_admin' || r === 'admin'

/** The login user's made-up email. Nobody receives mail there; it just ties the login to the person. */
const loginEmail = (personKey: string) => `${personKey}@people.orders.atomeats.com`

function cleanEmail(e: unknown): string | null {
  if (typeof e !== 'string' || !e.trim()) return null
  const v = e.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : 'invalid'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) })
  if (req.method !== 'POST') return json(req, { error: 'Not allowed' }, 405)

  // Who is asking? Checked with the database's own rules (active, own PIN set, login under 7 days).
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return json(req, { error: 'Please log in again.' }, 401)
  const asCaller = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: role } = await asCaller.rpc('my_role')
  if (!role || !isAdminRole(role)) return json(req, { error: 'Only admins can change the team.' }, 403)
  const { data: u } = await asCaller.auth.getUser(jwt)
  const db = adminDb()
  const { data: me } = await db.from('people').select('id, name, role').eq('id', u.user!.id).single()
  const isSuper = me!.role === 'super_admin'

  let body: Record<string, unknown> = {}
  try {
    body = await req.json()
  } catch { /* empty body */ }
  const action = String(body.action ?? '')

  /** Admins may only touch non-admins; the super admin may touch anyone. */
  const mayManage = (targetRole: string) => isSuper || !isAdminRole(targetRole)

  const loadTarget = async () => {
    const id = typeof body.id === 'string' ? body.id : ''
    const { data } = await db.from('people').select('*').eq('id', id).maybeSingle()
    return data
  }

  const giveFirstPin = async (personId: string) => {
    const pin = randomPin()
    await db.from('pin_security').upsert({
      person_id: personId, pin_hash: await bcrypt.hash(pin, 12), pin_set_at: new Date().toISOString(),
      failed_count: 0, lock_level: 0, locked_until: null,
    })
    await db.from('people').update({ must_change_pin: true }).eq('id', personId)
    return pin
  }

  switch (action) {
    case 'add': {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const username = normaliseUsername(body.username)
      const newRole = String(body.role ?? '')
      const email = cleanEmail(body.email)
      const phone = typeof body.phone === 'string' && body.phone.trim() ? body.phone.trim() : null
      if (!name) return json(req, { error: 'Please enter a name.' }, 400)
      if (!/^[a-z][a-z0-9.]{1,30}$/.test(username)) return json(req, { error: 'Login name: small letters and numbers only, no spaces (e.g. “zeeshan”).' }, 400)
      if (!ROLES.includes(newRole as Role)) return json(req, { error: 'Please choose a role.' }, 400)
      if (!mayManage(newRole)) return json(req, { error: 'Only the super admin can add admins.' }, 403)
      if (email === 'invalid') return json(req, { error: 'That email address doesn’t look right.' }, 400)
      const { data: taken } = await db.from('people').select('id').eq('username', username).maybeSingle()
      if (taken) return json(req, { error: `The login name “${username}” is already used. Try adding a letter.` }, 400)

      const { data: created, error } = await db.auth.admin.createUser({
        email: loginEmail(crypto.randomUUID()), email_confirm: true,
      })
      if (error || !created.user) {
        console.error('createUser failed', error)
        return json(req, { error: 'Could not create the login. Please try again.' }, 500)
      }
      const { error: insErr } = await db.from('people').insert({
        id: created.user.id, name, username, role: newRole, email, phone, created_by: me!.id,
      })
      if (insErr) {
        await db.auth.admin.deleteUser(created.user.id)
        console.error('people insert failed', insErr)
        return json(req, { error: 'Could not save the person. Please try again.' }, 500)
      }
      const pin = await giveFirstPin(created.user.id)
      await logActivity(db, me!.id, 'person_added', `${me!.name} added ${name} (${ROLE_NAMES[newRole as Role]})`,
        { entity_type: 'person', entity_id: created.user.id })
      return json(req, { ok: true, id: created.user.id, firstPin: pin })
    }

    case 'update': {
      const t = await loadTarget()
      if (!t) return json(req, { error: 'Person not found.' }, 404)
      if (!mayManage(t.role)) return json(req, { error: 'Only the super admin can change admins.' }, 403)

      const changes: Record<string, unknown> = {}
      const said: string[] = []
      if (typeof body.name === 'string' && body.name.trim() && body.name.trim() !== t.name) {
        changes.name = body.name.trim(); said.push(`name → ${changes.name}`)
      }
      if (body.username !== undefined) {
        const un = normaliseUsername(body.username)
        if (un !== t.username) {
          if (!/^[a-z][a-z0-9.]{1,30}$/.test(un)) return json(req, { error: 'Login name: small letters and numbers only, no spaces.' }, 400)
          const { data: taken } = await db.from('people').select('id').eq('username', un).maybeSingle()
          if (taken) return json(req, { error: `The login name “${un}” is already used.` }, 400)
          changes.username = un; said.push(`login name → ${un}`)
        }
      }
      if (body.role !== undefined && body.role !== t.role) {
        const r = String(body.role)
        if (!ROLES.includes(r as Role)) return json(req, { error: 'Please choose a role.' }, 400)
        if (!mayManage(r)) return json(req, { error: 'Only the super admin can make someone an admin.' }, 403)
        if (t.id === me!.id) return json(req, { error: 'You can’t change your own role.' }, 400)
        changes.role = r; said.push(`role → ${ROLE_NAMES[r as Role]}`)
      }
      if (body.email !== undefined) {
        const e = cleanEmail(body.email)
        if (e === 'invalid') return json(req, { error: 'That email address doesn’t look right.' }, 400)
        if (e !== t.email) { changes.email = e; said.push(`email → ${e ?? 'none'}`) }
      }
      if (body.phone !== undefined) {
        const ph = typeof body.phone === 'string' && body.phone.trim() ? body.phone.trim() : null
        if (ph !== t.phone) { changes.phone = ph; said.push(`phone → ${ph ?? 'none'}`) }
      }
      if (typeof body.active === 'boolean' && body.active !== t.active) {
        if (t.id === me!.id) return json(req, { error: 'You can’t switch yourself off.' }, 400)
        changes.active = body.active; said.push(body.active ? 'switched back on' : 'switched off')
      }
      if (!said.length) return json(req, { ok: true })

      await db.from('people').update(changes).eq('id', t.id)
      if (changes.active === false) await db.rpc('end_sessions', { p_user: t.id })
      await logActivity(db, me!.id, 'person_updated', `${me!.name} changed ${t.name}: ${said.join(', ')}`,
        { entity_type: 'person', entity_id: t.id })
      return json(req, { ok: true })
    }

    case 'reset_pin': {
      const t = await loadTarget()
      if (!t) return json(req, { error: 'Person not found.' }, 404)
      if (!mayManage(t.role)) return json(req, { error: 'Only the super admin can reset an admin’s PIN.' }, 403)
      if (t.id === me!.id) return json(req, { error: 'To change your own PIN, use “My PIN”.' }, 400)
      const pin = await giveFirstPin(t.id)
      await db.rpc('end_sessions', { p_user: t.id })
      await logActivity(db, me!.id, 'pin_reset_by_admin', `${me!.name} gave ${t.name} a new first PIN`,
        { entity_type: 'person', entity_id: t.id })
      return json(req, { ok: true, firstPin: pin })
    }

    case 'unlock': {
      const t = await loadTarget()
      if (!t) return json(req, { error: 'Person not found.' }, 404)
      await db.from('pin_security').update({ failed_count: 0, lock_level: 0, locked_until: null }).eq('person_id', t.id)
      await logActivity(db, me!.id, 'person_unlocked', `${me!.name} unlocked ${t.name}'s login`,
        { entity_type: 'person', entity_id: t.id })
      return json(req, { ok: true })
    }

    default:
      return json(req, { error: 'Unknown action' }, 400)
  }
})
