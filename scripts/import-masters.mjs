// One-time (re-runnable) import of products, Tally names, combos, customers and draft
// nicknames from the sample files. The files stay in the samples folder; nothing from
// them is written into this repo. Usage:
//   node scripts/import-masters.mjs "/path/to/atom eats sales dashboard"
// A plain-English report is written to scratch/import-report.txt.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import X from 'xlsx'
import { createClient } from '@supabase/supabase-js'
import { features, gstinState, GST_STATES, nameSimilarity, norm, scoreProduct, tidy } from '../src/lib/match.ts'

const DIR = process.argv[2]
if (!DIR || !existsSync(DIR)) throw new Error('Give the samples folder as the first argument.')
const REF = 'zpshpatshvvmcoyhmsrk'
const keys = JSON.parse(execFileSync(`${homedir()}/.local/tools/supabase-cli/supabase`, ['projects', 'api-keys', '--project-ref', REF, '-o', 'json'], { stdio: ['ignore', 'pipe', 'ignore'] }))
const db = createClient(`https://${REF}.supabase.co`, keys.find((k) => k.name === 'service_role').api_key, { auth: { persistSession: false } })

const report = []
const say = (s) => { report.push(s); console.log(s) }
const file = (re) => {
  const f = readdirSync(DIR).find((n) => re.test(n))
  if (!f) throw new Error(`Missing file like ${re}`)
  return join(DIR, f)
}
const sheet = (path, name, opts = {}) => {
  const wb = X.readFile(path, { raw: false })
  const ws = wb.Sheets[name ?? wb.SheetNames[0]]
  if (!ws) return []
  return X.utils.sheet_to_json(ws, { defval: '', raw: false, ...opts })
}
const rowsOf = (path, name) => sheet(path, name, { header: 1 }).map((r) => r.map((c) => String(c ?? '').trim()))
const clean = (s) => String(s ?? '').replace(/^`/, '').replace(/\s+/g, ' ').trim()
const digits = (s) => String(s ?? '').replace(/\D/g, '')
const phone10 = (s) => { const d = digits(s); return d.length >= 10 ? d.slice(-10) : null }
const fix = (s) => { const v = clean(s); return v && !/^(-|na|n\/a|same|sane|nil|none|0)$/i.test(v) ? v : null }

async function upsert(table, rows, onConflict, chunk = 300) {
  for (let i = 0; i < rows.length; i += chunk) {
    const { error } = await db.from(table).upsert(rows.slice(i, i + chunk), onConflict ? { onConflict } : undefined)
    if (error) throw new Error(`${table}: ${error.message}`)
  }
}

// ============================================================ PRODUCTS
const eeRows = sheet(file(/^ProductAttribute.*\.csv$/))
const products = new Map()
for (const r of eeRows) {
  const sku = clean(r.SKU)
  if (!sku) continue
  products.set(sku, {
    sku,
    name: clean(r.ProductName),
    mrp: Number(r.MRP) || null,
    weight_g: Number(r['Weight(gms)']) > 0 ? Math.round(Number(r['Weight(gms)'])) : null,
    ee_type: clean(r.SKUType) || null,
    gst_rate: /GST(\d+)/.exec(r.ProductTaxRule)?.[1] ? Number(/GST(\d+)/.exec(r.ProductTaxRule)[1]) : 5,
    image_url: clean(r.ImageURL) || null,
    in_easy_ecom: true,
    active: clean(r.Status).toLowerCase() === 'active',
  })
}
say(`Products: ${products.size} Easy Ecom SKUs read from the product export.`)

// --- Which SKU is used for offline orders
const offline = new Set()
const replacedBy = new Map()
const templates = file(/^Easy Ecom Templates\.xlsx$/)
for (const r of rowsOf(templates, 'Changes in the SKU').slice(1)) {
  const oldSku = clean(r[2]); const master = clean(r[3])
  if (master && products.has(master)) {
    offline.add(master)
    // The sheet also lists pack-of-3 combo fixes; only trust it when both SKUs have the same MRP.
    if (oldSku && products.has(oldSku) && oldSku !== master && products.get(oldSku).mrp === products.get(master).mrp) replacedBy.set(oldSku, master)
  }
}
const salesZips = readdirSync(DIR).filter((n) => /^sales_all.*\.zip$/.test(n))
const b2bUse = new Map()
for (const z of salesZips) {
  const csv = execFileSync('unzip', ['-p', join(DIR, z)], { maxBuffer: 200 * 1024 * 1024 }).toString('utf8')
  const wb = X.read(csv, { type: 'string', raw: false })
  for (const r of X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false })) {
    if (!['B2B', 'Offline'].includes(r['MP Name'])) continue
    const sku = clean(r.SKU)
    if (products.has(sku)) b2bUse.set(sku, (b2bUse.get(sku) ?? 0) + (Number(r['Item Quantity']) || 1))
  }
}
for (const sku of b2bUse.keys()) if (!replacedBy.has(sku)) offline.add(sku)
for (const p of products.values()) if (/, ?500 ?g$|1 ?kg/i.test(p.name)) offline.add(p.sku) // bulk packs are B2B only
say(`Offline SKUs: ${offline.size} (from Easy Ecom's "Changes in the SKU" sheet, the SKUs on B2B orders in the sales reports, and the 500 g bulk packs). ${replacedBy.size} old SKUs point to their master SKU.`)

// --- Twins: same Easy Ecom name and MRP (e.g. SKB01 and SKB00). Used to pass Tally names to the offline SKU.
const twinKey = (p) => `${norm(p.name)}|${p.mrp}`
const twins = new Map()
for (const p of products.values()) {
  const k = twinKey(p)
  twins.set(k, [...(twins.get(k) ?? []), p.sku])
}
const offlineTwin = (sku) => {
  if (replacedBy.has(sku)) return replacedBy.get(sku)
  if (offline.has(sku)) return sku
  return (twins.get(twinKey(products.get(sku))) ?? []).find((s) => offline.has(s)) ?? null
}

// ============================================================ TALLY NAMES
const rs = file(/^RS Master.*\.xlsx$/)
const tally = new Map() // sku -> { name, status }
const aliases = []      // { sku, alias, kind, status, source, times_seen?, customer_id? }
const addAlias = (sku, alias, kind, status = 'confirmed', source = '', times = 1) => {
  const a = clean(alias)
  if (!a || !products.has(sku) || !norm(a)) return
  aliases.push({ sku, alias: a, alias_norm: norm(a), kind, status, source, times_seen: times })
}
for (const r of rowsOf(rs, 'Raveena Final Purple Entries').slice(1)) {
  const [sku1, tname, sku2, shopName] = r.map(clean)
  if (!tname) continue
  for (const s of [sku1, sku2].filter((x) => products.has(x))) {
    tally.set(s, { name: tname, status: 'confirmed' })
    addAlias(s, tname, 'tally', 'confirmed', 'RS Master (Raveena final)')
    if (shopName && shopName !== 'NA') addAlias(s, shopName, 'shopify', 'confirmed', 'RS Master')
  }
}
// The longer working sheets: Tally name | Shopify name | SKU | SKU 2 → suggestions only.
for (const sh of ['Stock Summary', '23 June - Edited by Raveena']) {
  for (const r of rowsOf(rs, sh)) {
    const [, tname, shopName, s1, s2] = r.map(clean)
    if (!tname || /^name of stock/i.test(tname)) continue
    for (const s of [s1, s2].filter((x) => products.has(x))) {
      if (!tally.has(s)) tally.set(s, { name: tname, status: 'suggested' })
      addAlias(s, tname, 'tally', 'suggested', `RS Master (${sh})`)
      if (shopName && shopName !== 'NA') addAlias(s, shopName, 'shopify', 'confirmed', 'RS Master')
    }
  }
}
// Pass Tally names to the offline twin when it has none.
for (const [sku, t] of [...tally]) {
  const twin = offlineTwin(sku)
  if (twin && twin !== sku && !tally.has(twin)) tally.set(twin, { name: t.name, status: 'suggested' })
}
// A suggested Tally name whose weight disagrees with the product is dropped.
function tallyOk(sku, name) {
  const p = products.get(sku)
  const own = features(p.name).grams
  const tg = features(name).grams
  const bulkProduct = /500 ?g|1 ?kg/i.test(p.name)
  const bulkTally = tg != null && tg >= 500
  return !((own && tg && own !== tg) || /not in use|discontinued/i.test(name) || (bulkProduct && !bulkTally) || (!bulkProduct && bulkTally && (p.mrp ?? 0) < 600))
}
for (const [sku, t] of [...tally]) if (t.status === 'suggested' && !tallyOk(sku, t.name)) tally.delete(sku)
// Tally stock list: suggest a name for offline SKUs still without one.
const tallyStock = rowsOf(join(DIR, 'Bulk order screenshots', 'Stock Items from 1.4.26 to 30.9.26.xlsx'))
  .slice(12).map((r) => clean(r[0])).filter((n) => n && !/^grand total/i.test(n))
await upsert('tally_items', [...new Set(tallyStock)].map((name) => ({ name })), 'name')
const sizeOf = (s) => {
  const f = features(s)
  if (!f.grams) return null
  return `${f.grams >= 1000 ? `${f.grams / 1000} kg` : `${f.grams} g`}${f.jar ? ' jar' : ''}${f.party ? ' party pack' : ''}`
}

// ============================================================ RETAIL FORM HEADERS (retail flag, sizes, aliases)
const retailBook = file(/^Atom Eats Retail Order Form MIS/)
const headerRow = rowsOf(retailBook, 'Ashish 1809 - 2609')[0] ?? []
const retailHeaders = headerRow.slice(18, 69).filter((h) => h && !/^column|contact|order summary|stock in hand|notes|samples/i.test(h))
// Offline SKUs first; other single packs too (some retail items haven't had a B2B order yet).
const candidates = (all = false) => [...products.values()]
  .filter((p) => offline.has(p.sku) || (all && !replacedBy.has(p.sku) && p.ee_type !== 'Combo' && !offlineTwin(p.sku)))
  .map((p) => {
    const size = p.size ?? sizeOf(tally.get(p.sku)?.name) ?? ''
    const texts = [`${p.name} ${size}`, tally.get(p.sku)?.name].filter(Boolean)
    return { sku: p.sku, bonus: offline.has(p.sku) ? 0.1 : 0, feats: texts.map((t) => ({ ...features(t), mrp: p.mrp })) }
  })
function bestProduct(text, mrp = null, contextGrams = null, all = true) {
  const q = features(text)
  if (contextGrams && !q.grams) q.grams = contextGrams
  const scored = candidates(all).map((c) => ({ sku: c.sku, score: c.bonus + Math.max(...c.feats.map((f) => scoreProduct(q, f, mrp))) }))
    .sort((a, b) => b.score - a.score)
  return { best: scored[0], second: scored[1] }
}
// First pass of sizes from Tally names / Easy Ecom names.
for (const p of products.values()) p.size = sizeOf(p.name) ?? (tally.get(p.sku)?.status === 'confirmed' ? sizeOf(tally.get(p.sku).name) : null)
let retailMapped = 0
for (const h of retailHeaders) {
  const mrp = Number(/rs\.?\s*(\d+)/i.exec(h)?.[1]) || null
  const label = h.replace(/\|.*$/, '').trim()
  const { best, second } = bestProduct(label, mrp)
  if (best && best.score >= 0.7 && best.score - (second?.score ?? 0) >= 0.05) {
    const p = products.get(best.sku)
    p.is_retail = true
    offline.add(best.sku) // sold to retail stores, so it's an offline SKU
    p.size = sizeOf(p.name) ?? sizeOf(label) ?? p.size
    addAlias(best.sku, label, 'retail_form', 'confirmed', 'retail order form column')
    retailMapped++
  } else {
    say(`  Retail form column not matched: “${label}”${best ? ` (closest ${best.sku} ${products.get(best.sku).name}, ${best.score.toFixed(2)})` : ''}`)
  }
}
say(`Retail SKUs: ${retailMapped} of ${retailHeaders.length} retail order form columns matched to an offline SKU.`)

// Remaining offline SKUs without a Tally name → closest Tally stock item.
let tallySuggested = 0
for (const sku of offline) {
  if (tally.has(sku)) continue
  const p = products.get(sku)
  const q = { ...features(`${p.name} ${p.size ?? ''}`) }
  // Only Tally items of the same weight (when both say a weight), never "not in use" ones.
  const best = tallyStock.filter((n) => tallyOk(sku, n))
    .map((n) => ({ n, f: features(n) }))
    .filter(({ f }) => !q.grams || !f.grams || q.grams === f.grams)
    .map(({ n, f }) => ({ n, s: scoreProduct(q, f) })).sort((a, b) => b.s - a.s)[0]
  if (best && best.s >= 0.75) { tally.set(sku, { name: best.n, status: 'suggested' }); tallySuggested++ }
}
for (const p of products.values()) {
  const t = tally.get(p.sku)
  p.tally_name = t?.name ?? null
  p.tally_status = t?.status ?? 'none'
  if (!p.size) p.size = sizeOf(t?.name)
  p.is_offline = offline.has(p.sku)
  p.replaced_by = replacedBy.get(p.sku) ?? null
  p.is_retail = !!p.is_retail
  addAlias(p.sku, p.name, 'ee_name', 'confirmed', 'Easy Ecom product name')
}
const offNoTally = [...offline].filter((s) => !tally.has(s))
say(`Tally names: ${[...tally.values()].filter((t) => t.status === 'confirmed').length} confirmed from the RS Master sheet, ${[...tally.values()].filter((t) => t.status === 'suggested').length} suggested (${tallySuggested} from the Tally stock list). ${offNoTally.length} offline SKUs still have no Tally name.`)

// ============================================================ BARCODES, HSN, BLINKIT ITEM CODES
const eans = new Map()
for (const sh of X.readFile(templates).SheetNames) {
  const rows = rowsOf(templates, sh)
  const hdr = rows[0] ?? []
  const iS = hdr.indexOf('SKU'); const iE = hdr.findIndex((h) => /^EAN/i.test(h))
  if (iS < 0 || iE < 0) continue
  for (const r of rows.slice(1)) {
    const e = digits(r[iE]); const s = clean(r[iS])
    if (products.has(s) && /^\d{12,13}$/.test(e) && !/E\+/i.test(r[iE])) eans.set(s, e.replace(/^0(?=\d{12}$)/, ''))
  }
}
const hsn = new Map()
for (const f of readdirSync(DIR).filter((n) => /^\d{14}_\d{8}_\d{6}\.xlsx$/.test(n))) {
  for (const r of sheet(join(DIR, f))) {
    const desc = clean(r['Product Description']); const ean = digits(r['Product UPC'])
    if (!desc) continue
    const { best, second } = bestProduct(`${desc} ${r.Grammage ?? ''}`, Number(r.MRP) || null)
    if (!best || best.score < 0.7 || best.score - (second?.score ?? 0) < 0.05) { say(`  Blinkit item not matched: “${desc}”`); continue }
    if (/^\d{12,13}$/.test(ean) && !eans.has(best.sku)) eans.set(best.sku, ean)
    if (r['HSN Code']) hsn.set(best.sku, clean(r['HSN Code']))
    if (r['Item Code']) addAlias(best.sku, `Blinkit ${clean(r['Item Code'])}`, 'customer_code', 'confirmed', 'Blinkit PO item code')
    addAlias(best.sku, desc, 'customer_code', 'confirmed', 'Blinkit PO item name')
  }
}
for (const [s, e] of eans) { products.get(s).ean = e; addAlias(s, e, 'ean', 'confirmed', 'barcode') }
for (const [s, h] of hsn) products.get(s).hsn = h
say(`Barcodes (EAN): ${eans.size} SKUs (Easy Ecom stock-upload sheets and the Blinkit POs). HSN codes: ${hsn.size} SKUs (Blinkit POs). The Easy Ecom product export itself has no barcodes.`)

// --- Shopify / Amazon codes that are not Easy Ecom SKUs become aliases of the Easy Ecom SKU in the same row and pack size.
const asBook = file(/^Amazon & Shopify SKU list/)
let codeAliases = 0
for (const r of rowsOf(asBook, 'AS-13012026').slice(1)) {
  const market = /amazon/i.test(r[0]) ? 'amazon' : 'shopify'
  for (let c = 4; c <= 9; c++) {
    const codes = String(r[c] ?? '').split(/[,|\s]+/).map(clean).filter((x) => x && x !== '-')
    const anchor = codes.find((x) => products.has(x))
    if (!anchor) continue
    for (const code of codes) if (!products.has(code)) { addAlias(anchor, code, market, 'confirmed', 'Amazon & Shopify SKU list'); codeAliases++ }
    if (r[2]) addAlias(anchor, `${r[2]} ${r[3] ? `${r[3]}g` : ''} pack of ${c - 3}`, market, 'confirmed', 'Amazon & Shopify SKU list')
  }
}
say(`Shopify/Amazon: ${codeAliases} codes that aren't in Easy Ecom were linked to an Easy Ecom SKU; product names per pack size added as other names.`)

await upsert('products', [...products.values()].map(({ replaced_by, ...p }) => ({ ...p, replaced_by: null })), 'sku')
await upsert('products', [...products.values()].filter((p) => p.replaced_by).map((p) => ({ sku: p.sku, name: p.name, replaced_by: p.replaced_by })), 'sku')

// ============================================================ COMBOS
const combos = new Map()
for (const sh of ['Combo Product', 'Combo pack of 3 amazon', 'FBA Virtual Combo', 'Diwali combos', 'Diwali -1', 'Sheet21']) {
  for (const r of rowsOf(templates, sh).slice(1)) {
    const parent = clean(r[0])
    if (!products.has(parent)) continue
    const items = new Map()
    for (const cell of r.slice(1)) {
      const [s, q] = clean(cell).split('&')
      if (!s || !products.has(s)) continue
      if (!items.has(s)) items.set(s, Number(q) || 1)
    }
    if (items.size) combos.set(parent, items)
  }
}
const comboRows = [...combos].flatMap(([combo_sku, items]) => [...items].map(([component_sku, qty]) => ({ combo_sku, component_sku, qty })))
await db.from('combo_items').delete().neq('combo_sku', '')
await upsert('combo_items', comboRows, 'combo_sku,component_sku')
const comboNoRecipe = [...products.values()].filter((p) => p.ee_type === 'Combo' && p.is_offline && !combos.has(p.sku))
say(`Combos: ${combos.size} combos/gift boxes with their contents (${comboRows.length} lines). ${comboNoRecipe.length} offline combo SKUs have no contents listed yet: ${comboNoRecipe.map((p) => p.sku).join(', ') || 'none'}.`)

// ============================================================ CUSTOMERS
const customers = new Map() // import_key -> record
const byGstin = new Map(); const byName = new Map()
const channelFor = (name, fallback) =>
  /zomato|hyperpure|blinkit/i.test(name) ? 'Blinkit' : /foodstories|food stories/i.test(name) ? 'Foodstories'
    : /landcraft|food ?square/i.test(name) ? 'Food Square' : fallback
function findExisting(name, gstin) {
  // Same name = same customer. Same GSTIN with a different name (e.g. two Blinkit warehouses)
  // is left for an admin to decide on the duplicates screen.
  const c = byName.get(norm(name)) ?? null
  return c && (!gstin || !c.gstin || c.gstin === gstin) ? c : null
}
function remember(c) {
  if (c.gstin) byGstin.set(c.gstin, [...new Set([...(byGstin.get(c.gstin) ?? []), c])])
  byName.set(norm(c.name), c)
}
function fill(c, fields) { for (const [k, v] of Object.entries(fields)) if (v != null && v !== '' && (c[k] == null || c[k] === '')) c[k] = v }
function addCustomer(key, name, fields, address, aliasName) {
  const gstin = gstinState(fields.gstin) ? fields.gstin.toUpperCase() : null
  let c = customers.get(key) ?? findExisting(name, gstin)
  if (!c) {
    c = { import_key: key, name, addresses: [], aliases: new Set(), visits: 0 }
    customers.set(key, c)
  }
  fill(c, { ...fields, gstin })
  if (gstin) { c.gst_status = 'registered'; c.billing_state ??= GST_STATES[gstinState(gstin)] }
  if (address?.address && !c.addresses.some((a) => norm(a.address) === norm(address.address))) c.addresses.push(address)
  if (aliasName && norm(aliasName) !== norm(c.name)) c.aliases.add(aliasName)
  c.visits++
  remember(c)
  return c
}

// Easy Ecom customer lists
for (const [sh, fallback] of [['B2B Customers', 'B2B'], ['B2B FINAL', 'B2B'], ['Zomato', 'Blinkit'], ['Retail Customers', 'Retail (field sales)'], ['Copy of B2B Customers', 'B2B']]) {
  for (const r of sheet(templates, sh)) {
    const name = clean(r['Company Name'])
    if (!name || /^\d+$/.test(name)) continue
    const email = clean(r.Email)
    const c = addCustomer(`ee:${norm(name)}`, name, {
      gstin: clean(r['Tax Identification Number/ GST']), phone: phone10(r['Contact Number']),
      email: /dummy/i.test(email) ? null : email || null,
      billing_address: clean(r.Billing_Street) || null, billing_city: clean(r.Billing_City) || null,
      billing_state: clean(r.Billing_State) || null, billing_pin: digits(r['Billing_Postal Code']) || null,
      default_channel: channelFor(name, fallback), source: 'Easy Ecom customer list',
    }, {
      name: clean(r.Dispatch_Name) || name, address: clean(r.Dispatch_Street) || clean(r.Billing_Street),
      city: clean(r.Dispatch_City) || clean(r.Billing_City), state: clean(r.Dispatch_State) || clean(r.Billing_State),
      pin: digits(r['Dispatch_Postal Code']) || digits(r['Billing_Postal Code']), gstin: gstinState(r['Ship To GSTIN']) ? clean(r['Ship To GSTIN']).toUpperCase() : null,
    })
    c.in_easy_ecom = true
  }
}
const eeCount = [...customers.values()].length
// Tally customer list (names only)
const tallyCust = rowsOf(join(DIR, 'Bulk order screenshots', 'All Cutomers List.xlsx'))
const startT = tallyCust.findIndex((r) => /^particulars$/i.test(r[0]))
let tallyNew = 0
for (const r of tallyCust.slice(startT + 1)) {
  const name = clean(r[0])
  if (!name || /grand total|^sundry debtors$|^atom foods/i.test(name)) continue
  const before = customers.size
  const c = addCustomer(`tally:${norm(name)}`, name, { source: 'Tally customer list', default_channel: channelFor(name, null) })
  c.in_tally = true; c.tally_name ??= name
  if (customers.size > before) tallyNew++
}
// Old B2B Google Form
let b2bNew = 0
for (const r of sheet(file(/^Atom Eats B2B Orders MIS/), 'Form Responses 1')) {
  const name = clean(r['Party Name'])
  if (!name) continue
  const before = customers.size
  addCustomer(`b2bform:${norm(name)}`, name, {
    gstin: clean(r.GST), contact_name: fix(r['POC Name']), phone: phone10(r['POC Number']),
    billing_address: fix(r['Billing Address']), billing_city: fix(r.Location), default_channel: channelFor(name, 'B2B'), source: 'old B2B order form',
  }, { name, address: fix(r['Delivery Address']), city: fix(r.Location) })
  if (customers.size > before) b2bNew++
}
// Old retail field-sales Google Form
let retailNew = 0
const storeName = (s) => clean(s).replace(/\(.*?\)/g, ' ').replace(/\b(sih|stock in hand|order|no order)\b/gi, ' ').replace(/\s+/g, ' ').trim()
for (const sh of ['Form Responses 1', 'Ashish 1809 - 2609']) {
  for (const r of sheet(retailBook, sh)) {
    const raw = r['Store Name']
    const name = storeName(raw)
    if (!name || name.length < 3) continue
    const before = customers.size
    addCustomer(`retail:${norm(name)}`, name, {
      gstin: clean(r.GST), fssai: /^\d{14}$/.test(digits(r.FSSAI)) && !/E\+/i.test(r.FSSAI) ? digits(r.FSSAI) : null,
      phone: phone10(r['CONTACT NUMBER']), billing_address: fix(r['Full Address']),
      billing_city: fix(r.CITY), default_margin: Number(String(r.Margin).replace('%', '')) || null,
      default_channel: 'Retail (field sales)', source: 'old retail order form',
    }, fix(r['Full Address']) ? { name, address: fix(r['Full Address']), city: fix(r.CITY) } : null, clean(raw))
    if (customers.size > before) retailNew++
  }
}
say(`Customers: ${customers.size} in total — ${eeCount} from Easy Ecom's customer lists, ${tallyNew} more names only in Tally, ${b2bNew} from the old B2B form, ${retailNew} stores from the old retail form.`)

// Write customers (keeps Hub-made changes: only fills fields that are still empty).
const { data: existing } = await db.from('customers').select('id, import_key')
const idByKey = new Map((existing ?? []).filter((e) => e.import_key).map((e) => [e.import_key, e.id]))
const fresh = [...customers.values()].filter((c) => !idByKey.has(c.import_key))
const cols = ['import_key', 'name', 'default_channel', 'gst_status', 'gstin', 'fssai', 'contact_name', 'phone', 'email', 'billing_address', 'billing_city', 'billing_state', 'billing_pin', 'default_margin', 'tally_name', 'in_easy_ecom', 'in_tally', 'source']
for (let i = 0; i < fresh.length; i += 200) {
  const { data, error } = await db.from('customers').insert(fresh.slice(i, i + 200).map((c) => Object.fromEntries(cols.map((k) => [k, c[k] ?? (k.startsWith('in_') ? false : null)])))).select('id, import_key')
  if (error) throw new Error(`customers: ${error.message}`)
  for (const d of data) idByKey.set(d.import_key, d.id)
}
const addrRows = []; const custAliasRows = []
for (const c of fresh) {
  const id = idByKey.get(c.import_key)
  c.addresses.forEach((a, i) => addrRows.push({ customer_id: id, name: a.name ?? null, address: a.address ?? null, city: a.city || null, state: a.state || null, pin: a.pin || null, gstin: a.gstin ?? null, is_default: i === 0 }))
  const seenAl = new Set([norm(c.name)])
  for (const al of c.aliases) if (!seenAl.has(norm(al))) { seenAl.add(norm(al)); custAliasRows.push({ customer_id: id, alias: al, alias_norm: norm(al) }) }
}
for (let i = 0; i < addrRows.length; i += 300) { const { error } = await db.from('customer_addresses').insert(addrRows.slice(i, i + 300)); if (error) throw error }
await upsert('customer_aliases', custAliasRows, 'customer_id,alias_norm')
say(`  Saved ${fresh.length} new customers with ${addrRows.length} delivery addresses (customers already in the Hub were left as they are).`)

// ============================================================ POSSIBLE DUPLICATES
const { data: allCust } = await db.from('customers').select('id, name, gstin, phone').eq('active', true)
const pairs = []
for (let i = 0; i < allCust.length; i++) {
  for (let j = i + 1; j < allCust.length; j++) {
    const a = allCust[i]; const b = allCust[j]
    let reason = null; let score = 0
    if (a.gstin && a.gstin === b.gstin) { reason = 'same GSTIN'; score = 0.99 }
    else if (a.phone && a.phone === b.phone) { reason = 'same phone number'; score = 0.9 }
    else {
      const sim = nameSimilarity(a.name, b.name)
      if (sim >= 0.8) { reason = 'very similar name'; score = sim }
    }
    if (reason) pairs.push({ customer_a: a.id, customer_b: b.id, reason, score: Number(score.toFixed(3)) })
  }
}
const { data: decided } = await db.from('customer_duplicates').select('customer_a, customer_b')
const known = new Set((decided ?? []).map((d) => `${d.customer_a}|${d.customer_b}`))
const newPairs = pairs.filter((p) => !known.has(`${p.customer_a}|${p.customer_b}`) && !known.has(`${p.customer_b}|${p.customer_a}`))
for (let i = 0; i < newPairs.length; i += 300) { const { error } = await db.from('customer_duplicates').insert(newPairs.slice(i, i + 300)); if (error) throw error }
say(`Possible duplicate customers to check: ${pairs.length} pairs (${pairs.filter((p) => p.reason === 'same GSTIN').length} same GSTIN, ${pairs.filter((p) => p.reason === 'same phone number').length} same phone, ${pairs.filter((p) => p.reason === 'very similar name').length} very similar names).`)

// ============================================================ DRAFT NICKNAMES
// Read "name quantity" lines from old orders and chats, and see which product each name means.
function* orderLines(text) {
  let ctxGrams = null
  for (const line of text.split(/\r?\n/)) {
    let body = line.replace(/^\[[^\]]*\]\s*[^:]{1,40}:\s*/, '') // WhatsApp "[date] Name:" prefix
    if (/omitted|http|deleted/i.test(body)) continue
    const t = tidy(body)
    const lone = t.match(/^(\d+)(g|kg)$/)
    if (lone) { ctxGrams = Number(lone[1]) * (lone[2] === 'kg' ? 1000 : 1); continue }
    if (!t) { ctxGrams = null; continue }
    const words = t.split(' ')
    let buf = []
    for (let i = 0; i < words.length; i++) {
      const w = words[i]
      if (/^\d+$/.test(w) && buf.length) {
        const name = buf.join(' ')
        if (/[a-z]{3}/.test(name)) yield { name, grams: ctxGrams }
        buf = []
      } else if (!/^\d+$/.test(w)) buf.push(w)
    }
  }
}
const texts = []
for (const sh of ['Form Responses 1', 'Ashish 1809 - 2609', 'Sheet1']) {
  for (const r of sheet(retailBook, sh)) texts.push([r['ORDER SUMMARY'], r['STOCK IN HAND'], r.SAMPLES].filter(Boolean).join('\n'))
}
for (const r of sheet(file(/^Atom Eats B2B Orders MIS/), 'Form Responses 1')) texts.push(String(r.Order ?? '').replace(/\s*-\s*(\d+)\s*units?/gi, ' $1 '))
for (const zip of readdirSync(DIR).filter((n) => /\.zip$/.test(n) && !/^sales_all/.test(n))) {
  try { texts.push(execFileSync('unzip', ['-p', join(DIR, zip), 'chat.txt'], { maxBuffer: 100 * 1024 * 1024 }).toString('utf8')) } catch { /* not a chat export */ }
}
const knownNorms = new Set(aliases.map((a) => tidy(a.alias)))
for (const p of products.values()) knownNorms.add(tidy(p.name))
const seen = new Map() // phrase -> Map(sku -> count)
const cand = candidates(false)
const isBulk = new Set([...products.values()].filter((p) => /500 ?g|1 ?kg/i.test(`${p.name} ${p.size ?? ''}`)).map((p) => p.sku))
function bestFor(phrase, grams) {
  const q = features(phrase)
  if (grams && !q.grams) q.grams = grams
  const scored = cand.filter((c) => q.grams || !isBulk.has(c.sku)).map((c) => ({ sku: c.sku, score: c.bonus + Math.max(...c.feats.map((f) => scoreProduct(q, f))) })).sort((a, b) => b.score - a.score)
  return { best: scored[0], second: scored[1] }
}
const GENERIC = new Set(['pretzel', 'choco', 'chips', 'potato', 'variety', 'party'])
let lines = 0
for (const text of texts) {
  for (const { name, grams } of orderLines(text)) {
    lines++
    const words = name.split(' ')
    let pick = null
    for (let k = 1; k <= Math.min(5, words.length); k++) {
      const phrase = words.slice(-k).join(' ')
      const { best, second } = bestFor(phrase, grams)
      if (best && best.score >= 0.8 && best.score - (second?.score ?? 0) >= 0.08 && (!pick || best.score >= pick.score)) pick = { phrase, ...best }
    }
    if (!pick) continue
    // The product's distinctive words (not "pretzel", "choco", "chips"…) must mostly appear,
    // so "pretzel knots 50g" isn't pinned on Cinnamon Butter Pretzel Knots.
    const own = features(`${products.get(pick.sku).name}`).words.filter((w) => !GENERIC.has(w))
    const said = features(pick.phrase).words
    if (own.length && own.filter((w) => said.some((x) => x === w || x.startsWith(w) || w.startsWith(x))).length / own.length < 0.5) continue
    const m = seen.get(pick.phrase) ?? new Map()
    m.set(pick.sku, (m.get(pick.sku) ?? 0) + 1)
    seen.set(pick.phrase, m)
  }
}
let nick = 0
for (const [phrase, m] of seen) {
  const [sku, count] = [...m].sort((a, b) => b[1] - a[1])[0]
  if (count < 2 || knownNorms.has(phrase) || phrase.split(' ').length > 5) continue
  aliases.push({ sku, alias: phrase, alias_norm: norm(phrase), kind: 'nickname', status: 'suggested', source: `old orders and chats (${count} times)`, times_seen: count })
  nick++
}
say(`Draft nicknames: read ${lines} order lines from the old forms and the two WhatsApp chats; ${nick} nicknames suggested for you to check.`)

// Aliases: keep confirmed ones already in the Hub; add new ones.
const dedup = new Map()
for (const a of aliases) {
  const k = `${a.alias_norm}|${a.kind}`
  const prev = dedup.get(k)
  if (!prev || (prev.status === 'suggested' && a.status === 'confirmed')) dedup.set(k, a)
}
const { data: haveAliases } = await db.from('product_aliases').select('alias_norm, kind, customer_id')
const have = new Set((haveAliases ?? []).filter((a) => !a.customer_id).map((a) => `${a.alias_norm}|${a.kind}`))
const newAliases = [...dedup.values()].filter((a) => !have.has(`${a.alias_norm}|${a.kind}`))
for (let i = 0; i < newAliases.length; i += 300) { const { error } = await db.from('product_aliases').insert(newAliases.slice(i, i + 300)); if (error) throw new Error(`aliases: ${error.message}`) }
say(`Product names and codes saved: ${newAliases.length} new (${dedup.size} found in total).`)

await db.from('activity').insert({ kind: 'import', summary: `Set-up imported ${products.size} products and ${fresh.length} customers from the sample files` })
writeFileSync('scratch/import-report.txt', report.join('\n') + '\n')
console.log('\nReport saved to scratch/import-report.txt')
