// Made-up rows in the layout of the real Consolidated-GRN-Report (no real data in the repo).
import { describe, expect, it } from 'vitest'
import { readGrn } from '../supabase/functions/_shared/grn'

const HEAD = ['Item Code', 'po_number', 'Product UPC', 'Product Description', 'MRP', 'Tax Amount', 'Landing Rate - PO', 'Landing Rate - GRN', 'Quantity - PO', 'Quantity - GRN', 'Fill rate (%)', 'Total GRN Amount', 'GMV Loss']
const row = (v: unknown[]) => Object.fromEntries(HEAD.map((h, i) => [h, v[i]]))

describe('readGrn', () => {
  it('sums each PO and treats "-" as nothing received', () => {
    const r = readGrn([
      row([1, '11112222333344', '890001', 'Chips (40 g)', 100, 4, 70, 70, 10, 8, 80, 560, 140]),
      row([2, '11112222333344', '890002', 'Pretzels (70 g)', 200, 8, 140, '-', 5, '-', '-', 0, 700]),
      row([3, '55556666777788', '890001', 'Chips (40 g)', 100, 4, 70, 70, 6, 6, 100, 420, 0]),
    ])
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ po_number: '11112222333344', qty_po: 15, qty_grn: 8, amount: 560 })
    expect(r[0].lines[1]).toMatchObject({ item: 'Pretzels (70 g)', qty_grn: 0 })
    expect(r[1]).toMatchObject({ po_number: '55556666777788', qty_po: 6, qty_grn: 6 })
  })

  it('ignores discrepancy-note sheets', () => {
    expect(readGrn([{ dn_date: '2026-10-27', po_number: '11112222333344', dn_id: 'D1', dn_quantity: 6, dn_value: 100 }])).toEqual([])
  })
})
