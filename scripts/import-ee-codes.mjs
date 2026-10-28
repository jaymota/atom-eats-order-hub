// node scripts/import-ee-codes.mjs <Customer_Master_Data_….csv> [--apply]
// Links Hub customers to their Easy Ecom customer code (Easy Ecom → Masters → Customer Master → export).
// Same name = match. Otherwise the same GSTIN (only one customer on each side with it, names starting with the same word).
// Never overwrites a code someone already typed in. Without --apply it only reports.
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

const norm = (s) => String(s ?? '').toLowerCase().replace(/\b(pvt|private|ltd|limited|llp)\b/g, '').replace(/[^a-z0-9]/g, '')
const firstWord = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/)[0]
const gst = (s) => (/^\d{2}[A-Z0-9]{13}$/.test(String(s ?? '').trim().toUpperCase()) ? String(s).trim().toUpperCase() : null)

const wb = XLSX.read(readFileSync(file), { type: 'buffer' })
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' })
const ee = new Map() // code -> { code, name, gstin }
for (const r of rows) if (r.Customer_Code && String(r.Active) !== 'False') ee.set(r.Customer_Code, { code: String(r.Customer_Code).trim(), name: String(r.Company_Name).trim(), gstin: gst(r.Gst_Number) })

const ours = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from('customers').select('id, code, name, gstin, ee_customer_code').is('merged_into', null).range(from, from + 999)
  if (error) throw error
  ours.push(...data)
  if (data.length < 1000) break
}
const byName = new Map(), byGst = new Map(), eeByName = new Map(), eeByGst = new Map()
for (const c of ours) { byName.set(norm(c.name), [...(byName.get(norm(c.name)) ?? []), c]); if (gst(c.gstin)) byGst.set(gst(c.gstin), [...(byGst.get(gst(c.gstin)) ?? []), c]) }
for (const e of ee.values()) { eeByName.set(norm(e.name), [...(eeByName.get(norm(e.name)) ?? []), e]); if (e.gstin) eeByGst.set(e.gstin, [...(eeByGst.get(e.gstin) ?? []), e]) }

const links = [], unmatched = []
for (const e of ee.values()) {
  let c = (byName.get(norm(e.name)) ?? []).length === 1 && (eeByName.get(norm(e.name)) ?? []).length === 1 ? byName.get(norm(e.name))[0] : null
  let how = 'name'
  if (!c && e.gstin && (byGst.get(e.gstin) ?? []).length === 1 && (eeByGst.get(e.gstin) ?? []).length === 1
      && firstWord(byGst.get(e.gstin)[0].name) === firstWord(e.name)) { c = byGst.get(e.gstin)[0]; how = 'GSTIN' }
  if (c) links.push({ e, c, how }); else unmatched.push(e)
}
const used = new Map()
for (const l of links) used.set(l.c.id, [...(used.get(l.c.id) ?? []), l])
let done = 0, kept = 0
for (const [, ls] of used) {
  if (ls.length > 1) { console.log('SKIP two Easy Ecom customers for', ls[0].c.name, ls.map((l) => l.e.code).join(', ')); continue }
  const { e, c, how } = ls[0]
  if (c.ee_customer_code) { kept++; continue }
  console.log(`${how.padEnd(5)} ${c.code} ${c.name}  ←  ${e.code} ${e.name}`)
  if (apply) { const { error } = await db.from('customers').update({ ee_customer_code: e.code, in_easy_ecom: true }).eq('id', c.id); if (error) throw error }
  done++
}
console.log(`\n${done} linked${apply ? '' : ' (practice run — add --apply to save)'}, ${kept} already had a code, ${unmatched.length} Easy Ecom customers not found in the Hub:`)
for (const e of unmatched) console.log('   ', e.code, e.name, e.gstin ?? '')
