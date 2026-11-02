// node scripts/backfill-grns.mjs [--apply]
// Reads the GRN emails already in the inbox (the inbox function does this for new ones) and files
// each PO in the GRN list. Without --apply it only reports.
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { createClient } from '@supabase/supabase-js'
import XLSX from 'xlsx'
import { readGrn } from '../supabase/functions/_shared/grn.ts'

const REF = 'zpshpatshvvmcoyhmsrk'
const keys = JSON.parse(execFileSync(`${homedir()}/.local/tools/supabase-cli/supabase`, ['projects', 'api-keys', '--project-ref', REF, '-o', 'json'], { stdio: ['ignore', 'pipe', 'ignore'] }))
const db = createClient(`https://${REF}.supabase.co`, keys.find((k) => k.name === 'service_role').api_key, { auth: { persistSession: false } })
const apply = process.argv[2] === '--apply'

const { data: mails, error } = await db.from('inbox_emails').select('id, subject, received_at, status, inbox_files(path, name)').eq('kind', 'grn').order('received_at')
if (error) throw error
for (const m of mails) {
  const pos = []
  for (const f of m.inbox_files.filter((f) => /\.(xlsx?|csv)$/i.test(f.name))) {
    const { data: b } = await db.storage.from('order-files').download(f.path)
    const wb = XLSX.read(Buffer.from(await b.arrayBuffer()), { type: 'buffer' })
    for (const n of wb.SheetNames) pos.push(...readGrn(XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: '', raw: false })))
  }
  console.log(`${m.received_at.slice(0, 10)} ${m.status.padEnd(7)} ${pos.map((p) => `${p.po_number} (${p.qty_grn}/${p.qty_po})`).join(', ') || 'no POs found'}`)
  if (apply && pos.length) { const { error: e } = await db.rpc('record_grn', { p_email: m.id, p_pos: pos }); if (e) throw e }
}
console.log(apply ? 'Saved.' : '(practice run — add --apply to save)')
