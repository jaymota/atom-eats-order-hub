import { describe, expect, it } from 'vitest'
import { OFFLINE_HEAD, awbOf, batches, inSalesReport, offlineRows, phone10, type EeOrder } from '../src/lib/easyecom'

const o = (order_no: string, lines: number, invoice_no: string | null = null) =>
  ({ id: order_no, order_no, invoice_no, order_lines: Array.from({ length: lines }, (_, i) => ({ line_no: i + 1, sku: 'TPC01', qty: 5 })) }) as unknown as EeOrder

describe('batches', () => {
  it('keeps each order whole and every file under the limit (rows = product lines)', () => {
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

describe('Shipped upload clean-up (Easy Ecom error report, 4 Nov)', () => {
  const base = (x: Partial<EeOrder>) => ({ id: x.order_no, order_no: 'ORD-1', order_date: '2026-11-01', customer_name: 'A', same_as_billing: true, phone: null, tracking_no: null,
    invoice_no: 'AT/1', payment_type: 'Credit', order_lines: [{ line_no: 1, sku: 'TPC01', qty: 1, rate: 10 }], ...x }) as unknown as EeOrder
  const col = (name: string) => OFFLINE_HEAD.indexOf(name)
  it('phones become 10 digits', () => {
    expect(phone10('+91 98194 55288')).toBe('9819455288')
    expect(phone10('092234 87644')).toBe('9223487644')
    expect(phone10('9482490100')).toBe('9482490100')
  })
  it('tracking is letters and digits only, and never text like SELF COLLECTED', () => {
    expect(awbOf('\tCRN788797561050')).toBe('CRN788797561050')
    expect(awbOf('SELF COLLECTED')).toBe('')
  })
  it('an AWB shared by two orders in one file is left out', () => {
    const r = offlineRows([base({ order_no: 'ORD-54', tracking_no: 'D123456' }), base({ order_no: 'ORD-58', tracking_no: 'D123456' }), base({ order_no: 'ORD-60', tracking_no: 'D999999', phone: '+91 62027 91376' })])
    expect(r.slice(1).map((x) => x[col('Tracking Number')])).toEqual(['', '', 'D999999'])
    expect(r[3][col('Billing Address Phone')]).toBe('6202791376')
  })
})
