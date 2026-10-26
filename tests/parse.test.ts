import { describe, expect, it } from 'vitest'
import { readItems, readMessage } from '../src/lib/parse'

// Made-up messages in the same shapes as the real WhatsApp orders (no real customer data).
const SENTENCE = `Priya Sharma
Forwarded
Hi hii wanted to confirm 102 QTY truffle peanuts small pack and 102QTY Mexican Pretzels smallest pack for the client and wanted to place a personal order for my diwali party with 2 jumbo mix pretzel boxes!

Do let me know the payment total and how i can pay :)
6:09 pm
Confirmed order will get the billing details
6:09 pm`

const ADDRESSES = `Need 10 packets
1:17 pm
Forwarded
Billing address

Sample Traders LLP
Quattro
7, demo industrial estate
Senapati bapat marg
Lower Parel
Mumbai 400013

GSTIN :-
27AAAAA1111A1ZA

Delivery address will be
Sample Traders
Unit 118 A/B
mandir road lower level,
Lower Parel, Mumbai,
Maharashtra 400013
Rahul: +91 98765 43210
1:17 pm
Please make PI - for 10 Party pack sticks
Margin : 30%`

const NEXT_LINE_QTY = `1.Cream n onion pretzel knots.
3 pkt
2.korean bbq pretzel knots.   3
pkt
7:10 pm
BANDRA DEMO CAFE
Good evening,
Need to dispatch tomorrow`

const QTY_FIRST = `Amit Kumar

B5-53, Demo Apartments,
5th Floor,
Sri Aurobindo Marg,
New Delhi 110016

9876543210

Please dispatch this @Tejashree Chogale
 2 x salt n' vinegar
2 x hot honey
2 x dill pikle
2 x honey butter
2 x truffle banana
2 x truffle potato`

const NO_QTY = `truffle banana chips
truffle potato chips
salt n' vinegar
hot honey
cinnamon sugar
brownie nachos

Neha Gupta, 531, Demo Officers Enclave, Plot 11,
Sector 7, Dwarka, New Delhi
110075

+91 98765 12345 - Neha Gupta

Please dispatch this today.@Tejashree Chogale`

const DASH_QTY = `Plz send this order Today
Colaba outlet

Cream & onion spiced pretzel -
3 pkt

Del Add ;
Demo Mansion, Wodehouse Road, Opposite Regal Cinema, Colaba
Causeway, Colaba, Mumbai,
Maharashtra 400001`

describe('reading order messages', () => {
  it('finds items and quantities inside a sentence', () => {
    const r = readMessage(SENTENCE, ['Priya Sharma'])
    // Chatty lines without a number stay as possible items; the product matcher drops them.
    expect(r.items.filter((i) => i.qty).map((i) => [i.qty, i.text])).toEqual([
      [102, 'truffle peanuts small pack'],
      [102, 'Mexican Pretzels smallest pack for the client and wanted to place a personal order for my diwali party'],
      [2, 'jumbo mix pretzel boxes!'.replace('!', '')],
    ])
  })

  it('reads billing and delivery blocks, GSTIN, phone, PIN and margin', () => {
    const r = readMessage(ADDRESSES)
    expect(r.gstins).toEqual(['27AAAAA1111A1ZA'])
    expect(r.phones).toEqual(['9876543210'])
    expect(r.pins).toEqual(['400013'])
    expect(r.margin).toBe(30)
    expect(r.billingStart).not.toBeNull()
    expect(r.deliveryStart).not.toBeNull()
    const addr = [...r.addressLines].map((i) => r.lines[i])
    expect(addr).toContain('Sample Traders LLP')
    expect(addr).toContain('Maharashtra 400013')
    expect(r.items.map((i) => [i.qty, i.text])).toContainEqual([10, 'Party pack sticks'])
  })

  it('takes the quantity from the next line', () => {
    const r = readMessage(NEXT_LINE_QTY)
    expect(r.items.slice(0, 2).map((i) => [i.qty, i.text])).toEqual([
      [3, 'Cream n onion pretzel knots'],
      [3, 'korean bbq pretzel knots'],
    ])
  })

  it('reads "2 x item" lists and keeps the address out of the items', () => {
    const r = readMessage(QTY_FIRST)
    expect(r.items.filter((i) => i.qty).map((i) => [i.qty, i.text])).toEqual([
      [2, "salt n' vinegar"], [2, 'hot honey'], [2, 'dill pikle'], [2, 'honey butter'], [2, 'truffle banana'], [2, 'truffle potato'],
    ])
    expect(r.pins).toEqual(['110016'])
    expect(r.phones).toEqual(['9876543210'])
  })

  it('reads lists without quantities', () => {
    const r = readMessage(NO_QTY)
    expect(r.items.slice(0, 6).map((i) => i.text)).toEqual(['truffle banana chips', 'truffle potato chips', "salt n' vinegar", 'hot honey', 'cinnamon sugar', 'brownie nachos'])
    expect(r.items.slice(0, 6).every((i) => i.qty === null)).toBe(true)
    expect(r.pins).toEqual(['110075'])
  })

  it('reads "name - 3 pkt" and the delivery heading', () => {
    const r = readMessage(DASH_QTY)
    expect(r.items.map((i) => [i.qty, i.text])).toContainEqual([3, 'Cream & onion spiced pretzel'])
    expect(r.deliveryStart).not.toBeNull()
    expect(r.pins).toEqual(['400001'])
  })

  it('reads "200g*8" and "50 Units"', () => {
    expect(readItems(['Salted Pretzel Sticks 200g*8']).map((i) => [i.qty, i.text])).toEqual([[8, 'Salted Pretzel Sticks 200g']])
    expect(readItems(['Truffle Potato Chips 40g - 50 Units']).map((i) => [i.qty, i.text])).toEqual([[50, 'Truffle Potato Chips 40g']])
  })
})
