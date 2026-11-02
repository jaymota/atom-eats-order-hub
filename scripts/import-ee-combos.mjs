// node scripts/import-ee-combos.mjs <Virtual_Combo_sheet.csv> [--apply]
// Makes the Hub's combo contents match Easy Ecom's Virtual Combo export (Easy Ecom is the master):
// each combo's components ("SKU   &qty") replace what the Hub had. Combos Easy Ecom doesn't list are
// left alone. Combos or components that aren't Hub SKUs are skipped and listed. Without --apply it only reports.
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

const wb = XLSX.read(readFileSync(file), { type: 'buffer', raw: false })
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
const { data: prods, error } = await db.from('products').select('sku').limit(5000)
if (error) throw error
const known = new Set(prods.map((p) => p.sku))
const { data: old } = await db.from('combo_items').select('combo_sku, component_sku, qty').limit(10000)
const before = new Map()
for (const c of old) before.set(c.combo_sku, [...(before.get(c.combo_sku) ?? []), `${c.component_sku}&${c.qty}`])

let same = 0, changed = 0, added = 0
const skipped = []
for (const r of rows.slice(1)) {
  const combo = String(r[0]).trim()
  if (!combo) continue
  const parts = r.slice(1).map((c) => String(c).trim()).filter(Boolean).map((c) => { const [s, q] = c.split('&'); return { sku: s.trim(), qty: Math.max(1, Number(q) || 1) } })
  const unknown = [combo, ...parts.map((p) => p.sku)].filter((s) => !known.has(s))
  if (unknown.length) { skipped.push(`${combo}: not a Hub SKU — ${unknown.join(', ')}`); continue }
  const now = parts.map((p) => `${p.sku}&${p.qty}`).sort().join(',')
  const was = (before.get(combo) ?? []).sort().join(',')
  if (now === was) { same++; continue }
  if (was) changed++; else added++
  if (apply) {
    const { error: d } = await db.from('combo_items').delete().eq('combo_sku', combo)
    if (d) throw d
    const { error: i } = await db.from('combo_items').insert(parts.map((p) => ({ combo_sku: combo, component_sku: p.sku, qty: p.qty })))
    if (i) throw i
  }
}
console.log(`${same} combos already matched, ${changed} corrected, ${added} added${apply ? '' : ' (practice run — add --apply to save)'}.`)
if (skipped.length) { console.log(`${skipped.length} skipped:`); skipped.forEach((s) => console.log('   ', s)) }
