import { describe, expect, it } from 'vitest'
import { OFFLINE_HEAD, WHOLESALE_HEAD, newCustomerRows, offlineRows, problems, toCsv, wholesaleRows, type EeOrder } from '../src/lib/easyecom'

const o = (x: Partial<EeOrder> = {}): EeOrder => ({
  id: '1', order_no: 'ORD-00009', order_date: '2026-10-27', channel: 'B2B', stage: 'dispatched', salesperson_id: null,
  customer_id: 'c1', customer_name: 'Gold Tree, "Nuts"', contact_name: null, phone: '9999999999', email: null, gstin: '27AAACZ8867B1Z0', fssai: null,
  billing_address: 'Shop 4,\nMarket Rd', billing_city: 'Thane', billing_state: 'Maharashtra', billing_pin: '400601', same_as_billing: true,
  delivery_name: null, delivery_address: null, delivery_city: null, delivery_state: null, delivery_pin: null, delivery_gstin: null, delivery_phone: null,
  po_number: 'AE-PO-00003', po_date: null, payment_type: 'Credit', payment_terms: null, notes: null,
  invoice_no: 'AT/0988/2026-27', invoice_date: '2026-10-28', invoice_value: 300, shared_with: null, dispatch_date: '2026-10-28', courier: 'DTDC', tracking_no: 'D1',
  ee_uploaded_at: null, estimate_value: 300,
  order_lines: [{ line_no: 1, sku: 'TPC01', qty: 3, rate: 100, value: 300, mrp: 125, ean: '890', gst_rate: 5, hsn: null, tally_name: null, product_name: 'Truffle' }],
  customer: { code: 'AE-0007', ee_customer_code: 'EE77', in_easy_ecom: false }, ...x,
})

describe('Easy Ecom files', () => {
  it('wholesale: one row per line, with quantity and B2B/<invoice> reference', () => {
    const r = wholesaleRows([o()])
    expect(r[0]).toEqual(WHOLESALE_HEAD)
    expect(r[1]).toEqual(['EE77', 'B2B/AT/0988/2026-27', 'ORD-00009-1', 'TPC01', 3, '100.00', '`2026-10-28', 'Prepaid', '`890', '125.00'])
  })
  it('offline import: one row per unit, Credit becomes Prepaid', () => {
    const r = offlineRows([o()])
    expect(r[0]).toEqual(OFFLINE_HEAD)
    expect(r.length).toBe(4)
    expect(r[3][1]).toBe('`ORD-00009-1-3')
    expect(r[1][OFFLINE_HEAD.indexOf('Payment Type*')]).toBe('Prepaid')
    expect(r[1][OFFLINE_HEAD.indexOf('Invoice Code')]).toBe('AT/0988/2026-27')
  })
  it('CSV keeps commas, quotes and new lines safe', () => {
    expect(toCsv([['a,b', 'say "hi"', 'x\ny', 'plain', 3]])).toBe('"a,b","say ""hi""","x, y",plain,3\r\n')
  })
  it('new customers only once, and not if Easy Ecom knows them', () => {
    expect(newCustomerRows([o(), o({ id: '2' })]).length).toBe(1) // has an Easy Ecom code
    const fresh = o({ customer: { code: 'AE-0007', ee_customer_code: null, in_easy_ecom: false } })
    const r = newCustomerRows([fresh, { ...fresh, id: '2' }])
    expect(r.length).toBe(2)
    expect(r[1][22]).toBe('AE-0007')
  })
  it('flags SKUs Easy Ecom does not have', () => {
    expect(problems(o(), new Set(['TPC01']))).toEqual([])
    expect(problems(o(), new Set())).toEqual(['Not in Easy Ecom: TPC01'])
    expect(problems(o({ customer: null }), new Set(['TPC01']))).toEqual(['No Easy Ecom customer code'])
  })
})
