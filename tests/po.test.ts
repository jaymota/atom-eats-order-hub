// Made-up POs in the same layouts as the real ones (no real customer data in the repo).
import { describe, expect, it } from 'vitest'
import { blinkitSheet, poDate, readPo } from '../src/lib/po'

const FOODSTORIES = `FOODSTORIES PRIVATE LIMITED
PURCHASE ORDER
Vendor Address  ATOM FOODS LLP  P.O. Number  :4500000001
SOME ROAD  Date  :  14.10.2026
Delivered By  ATOM FOODS LLP  Payment Terms  :Due in 45 days
SOME ROAD  PO Delivery date  :20.10.2026
Delivery &  FOODSTORIES PRIVATE LIMITED  GST No.  :36AAAAA0000A1ZZ
Billing  FOODSTORIES TEST STORE
Address  SHOP 1, TEST TOWER
HYDERABAD-500001,TELANGANA
Article Code  M  Cost  Value  IGST Amt  Amt
Description of Goods
762497332162  19054000  550.00  10.000  EA  314.29  3,142.90  5.00  %  3,300.05
1000018956  157.15
ATOM EATS CLASSIC
PRETZEL VARIETY
30GX5
745314460736  190  99.00  20.000  EA  56.57  1,131.40  2.50  %  2.50  %  1,187.97
1000012556  540  28.29  28.29
ATOM EATS  00
SALTED MINI STICK 30G
Total  30.000  9,400.10  470.01  9,870.11`

const FOODSQUARE = `Purchase Order
FOOD SQUARE - Landcraft Retail Pvt. Ltd, TEST PARK
BILLING ADDRESS  SHIPPING ADDRESS
FOOD SQUARE TESTNAGAR  ,  Shop 2  FOOD SQUARE TESTNAGAR  ,  Shop 2
Test Rd, Mumbai,W  ,  Maharashtra  ,  400054  Test Rd, Mumbai,W  ,  Maharashtra  ,  400054
GST No :  27AAAAA1111A1ZZ  GST No :  27AAAAA1111A1ZZ
Vendor Name & Address  ATOM FOODS LLP  PO No :  49362
PO Date :  14/10/2026
5  ,  Mumbai  ,  Maharashtra  Delivery Date :  16/10/2026
1  0745314461054  ATOM EATS CARAMEL  190540  24  Unit  120  68.57  1645.68  2.5  2.5  0  1727.96
9054607  CHOCO PRETZELS 30G  00  41.14  41.14  0
0745314461054
2  0745314460729  ATOM EATS SALTED  190590  12  Unit  99  56.57  678.84  2.5  2.5  0  712.78
9041025  PRETZEL MINI KNOTS 30  30  16.97  16.97  0
0745314460729  G
Total  9  186  13745.04`

describe('PO readers', () => {
  it('reads dates in every layout', () => {
    expect(poDate('14.10.2026')).toBe('2026-10-14')
    expect(poDate('02/09/2024')).toBe('2024-09-02')
    expect(poDate('29-05-2026')).toBe('2026-05-29')
    expect(poDate('Oct. 12, 2026, 4:20 p.m.')).toBe('2026-10-12')
  })

  it('Foodstories: both GST layouts, item codes, rates incl. GST, delivery address', () => {
    const r = readPo([{ name: 'po.pdf', text: FOODSTORIES }], 'Revised PO: 4500000001')!
    expect(r.format).toBe('foodstories')
    expect(r).toMatchObject({ po_number: '4500000001', po_date: '2026-10-14', delivery_date: '2026-10-20', revised: true, gstin: '36AAAAA0000A1ZZ', buyer: 'FOODSTORIES TEST STORE' })
    expect(r.ship).toMatchObject({ pin: '500001', city: 'HYDERABAD' })
    expect(r.items.map((i) => [i.qty, i.ean, i.code, i.rate, i.mrp])).toEqual([
      [10, '762497332162', '1000018956', 330, 550],
      [20, '745314460736', '1000012556', 59.4, 99],
    ])
    expect(r.items[0].text).toBe('ATOM EATS CLASSIC PRETZEL VARIETY 30g pack of 5')
    expect(r.items[1].text).toBe('ATOM EATS SALTED MINI STICK 30G')
  })

  it('Food Square 2026: two-column address, wrapped names', () => {
    const r = readPo([{ name: 'po.pdf', text: FOODSQUARE }])!
    expect(r).toMatchObject({ format: 'foodsquare', po_number: '49362', po_date: '2026-10-14', delivery_date: '2026-10-16', buyer: 'FOOD SQUARE TESTNAGAR', gstin: '27AAAAA1111A1ZZ' })
    expect(r.ship).toMatchObject({ name: 'FOOD SQUARE TESTNAGAR', pin: '400054', city: 'Mumbai' })
    expect(r.items.map((i) => [i.text, i.qty, i.ean, i.code, i.rate])).toEqual([
      ['ATOM EATS CARAMEL CHOCO PRETZELS 30G', 24, '745314461054', '9054607', 72],
      ['ATOM EATS SALTED PRETZEL MINI KNOTS 30G', 12, '745314460729', '9041025', 59.4],
    ])
  })

  it('Blinkit: items from the Excel, PO number from its file name', () => {
    const rows = [
      ['#', 'Item Code', 'HSN Code', 'Product UPC', 'Product Description', 'Grammage', 'Basic Cost Price', 'IGST %', 'Landing Rate', 'Quantity', 'MRP'],
      [1, 10329421, '21069099', '762497332315', 'Atom Eats Dill Pickle Potato Chips(Packet)', '60 g', 83.33, 5, 87.5, 31, 125],
    ]
    expect(blinkitSheet(rows)[0]).toMatchObject({ text: 'Atom Eats Dill Pickle Potato Chips 60 g', qty: 31, ean: '762497332315', code: '10329421', rate: 87.5, mrp: 125 })
    const r = readPo([{ name: '35460210002616_20261023_120702.xlsx', rows }])!
    expect(r).toMatchObject({ format: 'blinkit', po_number: '35460210002616' })
  })

  it('returns null for POs it does not know', () => {
    expect(readPo([{ name: 'x.pdf', text: 'PURCHASE ORDER\nSome shop\n1 Chips 10' }])).toBeNull()
  })
})
