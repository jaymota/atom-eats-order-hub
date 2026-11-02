// node scripts/import-ee-customer-details.mjs <Customer_Master_Data_….csv> [--apply]
// Fills gaps in Hub customers from Easy Ecom's Customer Master export (Masters → Customer Master → export).
// Each customer has a "Billing" row (→ billing details) and a "Dispatch" row (→ a delivery address).
// Only customers already linked by Easy Ecom code (scripts/import-ee-codes.mjs). Only empty fields are
// filled: nothing typed in the Hub is overwritten; differences are listed instead. Without --apply it only reports.
// In this export Address_Line_1 is the contact person and Street is the address.
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import XLSX from 'xlsx'

const REF = 'zpshpatshvvmcoyhmsrk'
const keys = JSON.parse(execFileSync(`${homedir()}/.local/tools/supabase-cli/supabase`, ['projects', 'api-keys', '--project-ref', REF, '-o', 'json'], { stdio: ['ignore', 'pipe', 'ignore'] }))
const db = createClient(`https://${REF}.supabase.co`, keys.find((k) => k.name === 'service_role').api_key, { auth: { persistSession: false } })
const [file, flag] = process.argv.slice(2)
const apply = flag === '--apply'

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim() || null
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const gst = (s) => (/^\d{2}[A-Z0-9]{13}$/.test(String(s ?? '').trim().toUpperCase()) ? String(s).trim().toUpperCase() : null)
const phone = (s) => { const d = String(s ?? '').replace(/\D/g, '').slice(-10); return d.length === 10 ? d : null }
const pin = (s) => { const d = String(s ?? '').replace(/\D/g, ''); return d.length === 6 ? d : null }
const email = (s) => { const e = clean(s)?.toLowerCase(); return e && e.includes('@') && !/^dummy@/.test(e) ? e : null }

const wb = XLSX.read(readFileSync(file), { type: 'buffer' })
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' })
const ee = new Map() // code -> { billing, dispatch }
for (const r of rows) {
  const code = clean(r.Customer_Code)
  if (!code) continue
  const e = ee.get(code) ?? { name: clean(r.Company_Name) }
  e[String(r['Address Type']).toLowerCase() === 'dispatch' ? 'dispatch' : 'billing'] = r
  ee.set(code, e)
}

const ours = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from('customers').select('id, code, name, ee_customer_code, gstin, gst_status, fssai, contact_name, phone, email, billing_address, billing_city, billing_state, billing_pin, customer_addresses(address, pin)').is('merged_into', null).not('ee_customer_code', 'is', null).range(from, from + 999)
  if (error) throw error
  ours.push(...data)
  if (data.length < 1000) break
}
const byCode = new Map(ours.map((c) => [c.ee_customer_code, c]))

const filled = {}, differ = [], notInHub = []
let changedCustomers = 0, newAddresses = 0
for (const [code, e] of ee) {
  const c = byCode.get(code)
  if (!c) { notInHub.push(`${code} ${e.name}`); continue }
  const b = e.billing ?? e.dispatch, d = e.dispatch ?? e.billing
  const want = {
    gstin: gst(b.Gst_Number), fssai: clean(b['Fssai Number']), contact_name: clean(b.Address_Line_1), phone: phone(b.Mobile_Number), email: email(b.Email),
    billing_address: clean(b.Street), billing_city: clean(b.City), billing_state: clean(b.State), billing_pin: pin(b['Pin Code']),
  }
  const patch = {}
  for (const [k, v] of Object.entries(want)) {
    if (!v) continue
    if (c[k] == null || c[k] === '') { patch[k] = v; filled[k] = (filled[k] ?? 0) + 1 }
    else if (['gstin', 'billing_pin'].includes(k) && norm(c[k]) !== norm(v)) differ.push(`${c.code} ${c.name}: ${k === 'gstin' ? 'GSTIN' : 'billing PIN'} Hub ${c[k]} · Easy Ecom ${v}`)
  }
  if (patch.gstin && !c.gst_status) patch.gst_status = 'registered'
  if (Object.keys(patch).length) {
    changedCustomers++
    if (apply) { const { error } = await db.from('customers').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', c.id); if (error) throw error }
  }

  // The dispatch row becomes a delivery address unless the customer already has one like it
  // (same text, one inside the other, or the same PIN code).
  const addr = clean(d.Street), dPin = pin(d['Pin Code'])
  const like = (a) => { const x = norm(a.address), y = norm(addr); return x === y || (x && y && (x.includes(y) || y.includes(x))) || (dPin && a.pin === dPin) }
  if (addr && !c.customer_addresses.some(like)) {
    newAddresses++
    if (apply) {
      const { error } = await db.from('customer_addresses').insert({
        customer_id: c.id, name: c.name, address: addr, city: clean(d.City), state: clean(d.State), pin: pin(d['Pin Code']),
        gstin: gst(d.Gst_Number), contact_name: clean(d.Address_Line_1), phone: phone(d.Mobile_Number), is_default: c.customer_addresses.length === 0,
      })
      if (error) throw error
    }
  }
}

console.log(`${ee.size} customers in the file, ${ee.size - notInHub.length} linked to the Hub.`)
console.log(`${changedCustomers} customers get missing details filled: ${Object.entries(filled).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}.`)
console.log(`${newAddresses} delivery addresses added.${apply ? '' : ' (practice run — add --apply to save)'}`)
console.log(`\n${differ.length} differences left as they are in the Hub:`)
for (const l of differ) console.log('   ', l)
console.log(`\n${notInHub.length} Easy Ecom customers not linked to a Hub customer yet:`)
for (const l of notInHub) console.log('   ', l)
