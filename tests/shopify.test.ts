// A made-up Shopify order (no real data in the repo).
import { describe, expect, it } from 'vitest'
import { istDate, shopifyRow } from '../supabase/functions/_shared/shopify'

describe('shopifyRow', () => {
  it('keeps live lines, open quantities and India dates', () => {
    const r = shopifyRow({
      legacyResourceId: '501', name: '#1001', createdAt: '2026-11-02T20:00:00Z', updatedAt: '2026-11-03T05:00:00Z', cancelledAt: null,
      displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'PARTIALLY_FULFILLED', currentTotalPriceSet: { shopMoney: { amount: '899.00' } },
      shippingAddress: { name: 'Test Person', city: 'Pune' },
      fulfillments: [{ createdAt: '2026-11-03T04:00:00Z' }],
      lineItems: { nodes: [
        { sku: ' SPK03 ', title: 'Sour Cream Chips', variantTitle: 'Pack of 3', currentQuantity: 2, unfulfilledQuantity: 1 },
        { sku: 'TPC01', title: 'Truffle Chips', variantTitle: 'Default Title', currentQuantity: 0, unfulfilledQuantity: 0 },
      ] },
    })
    expect(r).toMatchObject({ id: 501, order_date: '2026-11-03', sent_on: '2026-11-03', total: 899, cancelled: false, customer: 'Test Person', city: 'Pune' })
    expect(r.lines).toEqual([{ sku: 'SPK03', title: 'Sour Cream Chips - Pack of 3', qty: 2, open: 1 }])
  })
  it('turns times into India dates', () => {
    expect(istDate('2026-11-02T18:29:00Z')).toBe('2026-11-02')
    expect(istDate('2026-11-02T18:31:00Z')).toBe('2026-11-03')
  })
})
