import { describe, expect, it } from 'vitest'
import { batches, inSalesReport, type EeOrder } from '../src/lib/easyecom'

const o = (order_no: string, qty: number, invoice_no: string | null = null) =>
  ({ id: order_no, order_no, invoice_no, order_lines: [{ line_no: 1, sku: 'TPC01', qty }] }) as unknown as EeOrder

describe('batches', () => {
  it('keeps each order whole and every file under the limit', () => {
    const parts = batches([o('ORD-1', 640), o('ORD-2', 288), o('ORD-3', 1100), o('ORD-4', 16)], 1000)
    expect(parts.map((p) => p.map((x) => x.order_no))).toEqual([['ORD-3'], ['ORD-1', 'ORD-2', 'ORD-4']])
  })
  it('is one file when it fits', () => {
    expect(batches([o('ORD-1', 5), o('ORD-2', 5)])).toHaveLength(1)
  })
})

describe('inSalesReport', () => {
  const orders = [o('ORD-00042', 1, 'AT/01312/2026-27'), o('ORD-00032', 1, 'AT/01306/2026-27'), o('ORD-00040', 1, 'AT/01254/2026-27')]
  it('finds Shipped uploads by order number and B2B entries by invoice number', () => {
    const rows = [
      { 'Reference Code': '`ORD-00042', 'MP Ref No': 'AT/01312/2026-27' },
      { 'Reference Code': '`B2B/AT/01306/2026-27', 'MP Ref No': 'B2B/AT/01306/2026-27' },
      { 'Reference Code': '`B2B/AT/01254/2026-28', 'MP Ref No': '' },
    ]
    expect(inSalesReport(orders, rows).map((x) => x.order_no)).toEqual(['ORD-00042', 'ORD-00032'])
  })
})
