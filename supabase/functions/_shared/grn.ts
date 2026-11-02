// Reads a GRN sheet (Blinkit / Zomato Hyperpure "Consolidated-GRN-Report": one row per item, with
// po_number, Quantity - PO, Quantity - GRN, Total GRN Amount) into one summary per PO.
// Discrepancy-note sheets and anything without a PO and a GRN quantity column give nothing.
// Used by the inbox function (and the backfill script), so it has no imports.

export interface GrnLine { item: string; upc: string; qty_po: number; qty_grn: number; amount: number }
export interface GrnPo { po_number: string; qty_po: number; qty_grn: number; amount: number; lines: GrnLine[] }

const num = (v: unknown) => { const n = Number(String(v ?? '').replace(/[,₹\s]/g, '')); return Number.isFinite(n) ? n : 0 } // "-" = 0

export function readGrn(rows: Record<string, unknown>[]): GrnPo[] {
  if (!rows.length) return []
  const cols = Object.keys(rows[0])
  const col = (re: RegExp) => cols.find((c) => re.test(c.trim()))
  const po = col(/^po[\s_-]*(number|no\.?)$/i)
  const qPo = col(/^quantity\s*-\s*po$/i)
  const qGrn = col(/^quantity\s*-\s*grn$/i)
  if (!po || !qGrn) return []
  const amt = col(/^total\s+grn\s+amount$/i)
  const item = col(/^(product\s+description|item[\s_]name)$/i)
  const upc = col(/^(product\s+)?upc$/i)

  const byPo = new Map<string, GrnPo>()
  for (const r of rows) {
    const p = String(r[po] ?? '').trim()
    if (!/^[A-Z0-9/-]{4,}$/i.test(p)) continue
    const s = byPo.get(p) ?? { po_number: p, qty_po: 0, qty_grn: 0, amount: 0, lines: [] }
    const l: GrnLine = { item: String(item ? r[item] ?? '' : '').trim(), upc: String(upc ? r[upc] ?? '' : '').trim(), qty_po: qPo ? num(r[qPo]) : 0, qty_grn: num(r[qGrn]), amount: amt ? num(r[amt]) : 0 }
    s.lines.push(l)
    s.qty_po += l.qty_po; s.qty_grn += l.qty_grn; s.amount += l.amount
    byPo.set(p, s)
  }
  return [...byPo.values()].map((s) => ({ ...s, amount: Math.round(s.amount * 100) / 100 }))
}
