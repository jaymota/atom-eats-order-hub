// One-time setup: creates the first team accounts from a private JSON list and gives each
// a first PIN. Usage:  node scripts/seed-team.mjs scratch/team.json
// The first PINs are written to scratch/first-pins.txt (never uploaded). People already on
// the team are skipped. Needs the Supabase command-line tool to be logged in.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import bcrypt from 'bcryptjs'
import { createClient } from '@supabase/supabase-js'
import { randomPin } from '../supabase/functions/_shared/pin.ts'

const REF = 'zpshpatshvvmcoyhmsrk'
const CLI = `${homedir()}/.local/tools/supabase-cli/supabase`

const keys = JSON.parse(execFileSync(CLI, ['projects', 'api-keys', '--project-ref', REF, '-o', 'json'], { stdio: ['ignore', 'pipe', 'ignore'] }))
const serviceKey = keys.find((k) => k.name === 'service_role')?.api_key
if (!serviceKey) throw new Error('Could not get the service key from the Supabase tool.')
const db = createClient(`https://${REF}.supabase.co`, serviceKey, { auth: { persistSession: false } })

const team = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const lines = ['Order Hub first PINs. Each person must choose their own PIN the first time they log in.', '']

for (const p of team) {
  const { data: existing } = await db.from('people').select('id').eq('username', p.username).maybeSingle()
  if (existing) {
    console.log(`skip ${p.username} (already on the team)`)
    continue
  }
  const { data: created, error } = await db.auth.admin.createUser({
    email: `${crypto.randomUUID()}@people.orders.atomeats.com`, email_confirm: true,
  })
  if (error) throw error
  const { error: insErr } = await db.from('people').insert({
    id: created.user.id, name: p.name, username: p.username, role: p.role, email: p.email ?? null,
  })
  if (insErr) throw insErr
  const pin = randomPin()
  const { error: pinErr } = await db.from('pin_security').insert({ person_id: created.user.id, pin_hash: await bcrypt.hash(pin, 12) })
  if (pinErr) throw pinErr
  await db.from('activity').insert({
    kind: 'person_added', summary: `Set-up added ${p.name}`, entity_type: 'person', entity_id: created.user.id,
  })
  lines.push(`${p.name.padEnd(18)} login name: ${p.username.padEnd(11)} first PIN: ${pin}`)
  console.log(`added ${p.username}`)
}

const out = process.argv[3] ?? 'scratch/first-pins.txt'
writeFileSync(out, lines.join('\n') + '\n')
console.log(`First PINs saved in ${out}`)
