// PIN login for the team. PINs are only ever checked here, on the server.
//
// Actions: login, change_pin, request_reset_code, reset_pin, logout_everywhere
import bcrypt from 'npm:bcryptjs@2.4.3'
import {
  adminDb, anonDb, clientIp, cors, deviceLabel, emailLayout, escapeHtml, getCaller, istNow, istTime,
  json, logActivity, randomCode, rateLimit, sendEmail, sha256, superAdminEmails,
} from '../_shared/server.ts'
import { lockMinutes, normaliseUsername, pinProblem } from '../_shared/pin.ts'

const MAX_TRIES = 5
const CODE_MINUTES = 15

interface Person {
  id: string
  name: string
  username: string
  email: string | null
  active: boolean
  must_change_pin: boolean
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) })
  if (req.method !== 'POST') return json(req, { error: 'Not allowed' }, 405)

  const db = adminDb()
  const ip = clientIp(req)
  const ua = (req.headers.get('user-agent') ?? '').slice(0, 300)
  let body: Record<string, unknown> = {}
  try {
    body = await req.json()
  } catch { /* empty body */ }
  const action = String(body.action ?? '')

  const logLogin = (kind: string, person: Person | null, usernameTried?: string) =>
    db.from('login_events').insert({ kind, person_id: person?.id ?? null, username_tried: usernameTried ?? null, ip, user_agent: ua })

  const findPerson = async (username: string): Promise<Person | null> => {
    if (!username) return null
    const { data } = await db.from('people').select('id, name, username, email, active, must_change_pin')
      .eq('username', username).maybeSingle()
    return (data as Person) ?? null
  }

  /** Sign the person in and hand the browser a session. No passwords involved:
   *  the server makes a one-time link for the person and uses it straight away. */
  const issueSession = async (person: Person) => {
    const { data: u } = await db.auth.admin.getUserById(person.id)
    const email = u.user?.email
    const { data: link, error: linkErr } = email
      ? await db.auth.admin.generateLink({ type: 'magiclink', email })
      : { data: null, error: new Error('no login user') }
    const tokenHash = link?.properties?.hashed_token
    if (linkErr || !tokenHash) {
      console.error('generateLink failed', linkErr)
      return json(req, { error: 'Could not start your session. Please try again.' }, 500)
    }
    const { data, error } = await anonDb().auth.verifyOtp({ type: 'magiclink', token_hash: tokenHash })
    if (error || !data.session) {
      console.error('verifyOtp failed', error)
      return json(req, { error: 'Could not start your session. Please try again.' }, 500)
    }
    await db.from('people').update({ last_login_at: new Date().toISOString() }).eq('id', person.id)
    await logLogin('login_success', person)
    return json(req, {
      ok: true,
      mustChangePin: person.must_change_pin,
      session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token },
    })
  }

  const setPin = async (person: Person, pin: string, mustChange: boolean) => {
    const pin_hash = await bcrypt.hash(pin, 12)
    await db.from('pin_security').upsert({
      person_id: person.id, pin_hash, pin_set_at: new Date().toISOString(), failed_count: 0, lock_level: 0, locked_until: null,
    })
    await db.from('people').update({ must_change_pin: mustChange }).eq('id', person.id)
    await db.from('ip_limits').delete().eq('ip', ip)
  }

  const alertPinChanged = (person: Person, how: string) =>
    sendEmail({
      to: [person.email ?? ''],
      subject: `Order Hub: ${person.name}'s PIN was changed`,
      html: emailLayout(`${person.name}'s PIN was changed`,
        `<p>${escapeHtml(person.name)}'s Order Hub PIN was ${escapeHtml(how)} at ${escapeHtml(istNow())} IST from ${escapeHtml(deviceLabel(ua))}.</p>
         <p>If this wasn't them, ask an admin to reset the PIN straight away.</p>`),
    })

  switch (action) {
    case 'login': {
      const username = normaliseUsername(body.username)
      const pin = typeof body.pin === 'string' ? body.pin : ''
      const now = Date.now()

      const { data: ipRow } = await db.from('ip_limits').select('*').eq('ip', ip).maybeSingle()
      if (ipRow?.locked_until && Date.parse(ipRow.locked_until) > now) {
        return json(req, { error: 'Too many wrong tries from this connection. Login is locked for now.', lockedUntil: ipRow.locked_until }, 429)
      }

      const person = await findPerson(username)
      const { data: sec } = person
        ? await db.from('pin_security').select('*').eq('person_id', person.id).maybeSingle()
        : { data: null }

      if (sec?.locked_until && Date.parse(sec.locked_until) > now) {
        return json(req, { error: 'Too many wrong PINs for this name. Login is locked for now.', lockedUntil: sec.locked_until }, 429)
      }

      const ok = !!person && person.active && !!sec?.pin_hash && /^\d{6,12}$/.test(pin) && (await bcrypt.compare(pin, sec.pin_hash))

      if (!ok) {
        await logLogin('login_failed', person, username)

        // Per-person counter (only when the name exists).
        let personUntil: string | null = null
        let personFails = 0
        if (person && sec) {
          personFails = sec.failed_count + 1
          let level = sec.lock_level
          if (personFails >= MAX_TRIES) {
            level += 1
            personUntil = new Date(now + lockMinutes(level) * 60_000).toISOString()
            personFails = 0
          }
          await db.from('pin_security').update({ failed_count: personFails, lock_level: level, locked_until: personUntil }).eq('person_id', person.id)
        }

        // Per-connection counter (counts unknown names too).
        let ipFails = (ipRow?.fails ?? 0) + 1
        let ipLevel = ipRow?.lock_level ?? 0
        let ipUntil: string | null = null
        if (ipFails >= MAX_TRIES * 2) {
          ipLevel += 1
          ipUntil = new Date(now + lockMinutes(ipLevel) * 60_000).toISOString()
          ipFails = 0
        }
        await db.from('ip_limits').upsert({ ip, fails: ipFails, lock_level: ipLevel, locked_until: ipUntil, updated_at: new Date().toISOString() })

        const lockAt = personUntil ?? ipUntil
        if (lockAt) {
          await logLogin('locked', person, username)
          const who = person ? escapeHtml(person.name) : `the name “${escapeHtml(username)}”`
          await sendEmail({
            to: [...(await superAdminEmails(db)), person?.email ?? ''],
            subject: 'Order Hub security alert: login locked',
            html: emailLayout('Login locked after wrong PINs',
              `<p>There were too many wrong PIN attempts for ${who}, so login is locked until <b>${escapeHtml(istTime(lockAt))} IST</b>.</p>
               <p style="color:#555">Last attempt: ${escapeHtml(istNow())} IST<br>IP: ${escapeHtml(ip)}<br>Device: ${escapeHtml(deviceLabel(ua))}</p>
               <p>If this was a team member who forgot their PIN, an admin can reset it in Team. Otherwise no action is needed: the lock protects the Hub.</p>`),
          })
          return json(req, { error: 'Too many wrong PINs. Login is locked for now.', lockedUntil: lockAt }, 429)
        }
        if (person && sec) {
          const left = MAX_TRIES - personFails
          return json(req, { error: `Wrong name or PIN. ${left} ${left === 1 ? 'try' : 'tries'} left before a lock.` }, 401)
        }
        return json(req, { error: 'Wrong name or PIN.' }, 401)
      }

      await db.from('pin_security').update({ failed_count: 0, lock_level: 0, locked_until: null }).eq('person_id', person!.id)
      await db.from('ip_limits').delete().eq('ip', ip)
      return issueSession(person!)
    }

    case 'change_pin': {
      const caller = await getCaller(req, db)
      if (!caller) return json(req, { error: 'Please log in again.' }, 401)
      const { data: p } = await db.from('people').select('id, name, username, email, active, must_change_pin').eq('id', caller.id).single()
      const person = p as Person
      const { data: sec } = await db.from('pin_security').select('pin_hash').eq('person_id', person.id).maybeSingle()
      const oldPin = typeof body.oldPin === 'string' ? body.oldPin : ''
      if (!sec?.pin_hash || !(await bcrypt.compare(oldPin, sec.pin_hash))) {
        await logLogin('change_pin_failed', person)
        return json(req, { error: 'Your current PIN is not correct.' }, 400)
      }
      const problem = pinProblem(body.newPin)
      if (problem) return json(req, { error: problem }, 400)
      if (body.newPin === oldPin) return json(req, { error: 'Please choose a PIN different from the old one.' }, 400)
      const wasFirst = person.must_change_pin
      await setPin(person, body.newPin as string, false)
      await logLogin('pin_changed', person)
      await logActivity(db, person.id, 'pin_changed', wasFirst ? `${person.name} chose their own PIN` : `${person.name} changed their PIN`)
      if (!wasFirst) await alertPinChanged(person, 'changed')
      return json(req, { ok: true })
    }

    case 'request_reset_code': {
      const person = await findPerson(normaliseUsername(body.username))
      // Same answer whether or not the name exists, so names can't be guessed this way.
      const generic = { ok: true, message: 'If that name is on the team, a code has been emailed to its email address.' }
      if (!person || !person.active || !person.email) return json(req, generic)
      if (!(await rateLimit(db, `reset:${person.id}`, 3, 60)) || !(await rateLimit(db, `reset-ip:${ip}`, 10, 60))) {
        return json(req, { error: 'Too many codes requested. Please wait an hour, or ask an admin to reset your PIN.' }, 429)
      }
      const code = randomCode()
      await db.from('auth_codes').insert({
        person_id: person.id,
        code_hash: await sha256(`reset:${person.id}:${code}`),
        expires_at: new Date(Date.now() + CODE_MINUTES * 60_000).toISOString(),
        ip,
      })
      await logLogin('pin_reset_requested', person)
      const sent = await sendEmail({
        to: [person.email],
        subject: `Order Hub code for ${person.name}: ${code}`,
        html: emailLayout(`PIN reset code for ${person.name}`,
          `<p>Use this code to choose a new Order Hub PIN for <b>${escapeHtml(person.name)}</b>.</p>
           <p style="font-size:28px;letter-spacing:6px;font-weight:700;margin:18px 0">${code}</p>
           <p style="color:#555">Requested from ${escapeHtml(deviceLabel(ua))} at ${escapeHtml(istNow())} IST. It expires in ${CODE_MINUTES} minutes.</p>
           <p style="color:#555">If nobody asked for this, ignore the email.</p>`),
      })
      if (!sent.ok) return json(req, { error: 'Emails are not switched on yet. Please ask an admin to reset your PIN in Team.' }, 400)
      return json(req, generic)
    }

    case 'reset_pin': {
      const person = await findPerson(normaliseUsername(body.username))
      const code = typeof body.code === 'string' ? body.code.trim() : ''
      const problem = pinProblem(body.pin)
      if (problem) return json(req, { error: problem }, 400)
      const bad = () => json(req, { error: 'That code is wrong or has expired.' }, 400)
      if (!person || !person.active) return bad()
      const { data: row } = await db.from('auth_codes').select('*')
        .eq('person_id', person.id).is('used_at', null).gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (!row || row.attempts >= 5) return bad()
      if (row.code_hash !== (await sha256(`reset:${person.id}:${code}`))) {
        await db.from('auth_codes').update({ attempts: row.attempts + 1 }).eq('id', row.id)
        return bad()
      }
      await db.from('auth_codes').update({ used_at: new Date().toISOString() }).eq('id', row.id)
      await setPin(person, body.pin as string, false)
      await db.rpc('end_sessions', { p_user: person.id })
      await logLogin('pin_reset', person)
      await logActivity(db, person.id, 'pin_reset', `${person.name} reset their PIN with an emailed code`)
      await alertPinChanged(person, 'reset with an emailed code')
      return issueSession({ ...person, must_change_pin: false })
    }

    case 'logout_everywhere': {
      const caller = await getCaller(req, db)
      if (!caller) return json(req, { error: 'Please log in again.' }, 401)
      await db.rpc('end_sessions', { p_user: caller.id })
      await logActivity(db, caller.id, 'logout_everywhere', `${caller.name} logged out on every device`)
      return json(req, { ok: true })
    }

    default:
      return json(req, { error: 'Unknown action' }, 400)
  }
})
