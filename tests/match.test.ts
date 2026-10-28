import { describe, expect, it } from 'vitest'
import { features, gstinState, nameSimilarity, scoreProduct, tidy } from '../src/lib/match'

const best = (query: string, products: Record<string, string>, mrp?: number) =>
  Object.entries(products)
    .map(([sku, text]) => ({ sku, s: scoreProduct(features(query), features(text), mrp) }))
    .sort((a, b) => b.s - a.s)[0].sku

const CATALOG = {
  KNOTS30: 'Mini Pretzel Knots 30 g',
  KNOTSJAR: 'Mini Pretzel Knots 70 g jar',
  KNOTSPP: 'Mini Pretzel Knots Party Pack 200 g party pack',
  STICKS30: 'Mini Pretzel Sticks 30 g',
  LARGE30: 'Large Pretzel Knots 30 g',
  MEX30: 'Mexican Chilli Pretzels 30 g',
  MEXPP: 'Mexican Chilli Pretzels Party Pack 200 g party pack',
  MILK30: 'Milk Choco Pretzels 30 g',
  DILL60: 'Dill Pickle Potato Chips 60 g',
  CINN50: 'Cinnamon Butter Pretzel Knots 50 g',
}

describe('tidying what people type', () => {
  it('fixes common misspellings and units', () => {
    expect(tidy('Mini Konts 30 GM')).toBe('mini knots 30g')
    expect(tidy('Maxican chili')).toBe('mexican chilli')
    expect(tidy('Milk Chocolate')).toBe('milk choco')
    expect(tidy('Dill pikle')).toBe('dill pickle')
  })
  it('reads weight, pack size, jar and party pack', () => {
    expect(features('Mini Pretzel Knots 70g Jar')).toMatchObject({ grams: 70, jar: true, party: false })
    expect(features('Mexican Chilli Party Pack, 200g')).toMatchObject({ grams: 200, party: true })
    expect(features('Truffle Potato Chips - Pack of 3')).toMatchObject({ packOf: 3 })
    expect(features('Atom Eats Brownie Nachos, 1Kg').grams).toBe(1000)
  })
})

describe('finding the product someone means', () => {
  it('handles real order-message spellings', () => {
    expect(best('Mini Konts', CATALOG)).toBe('KNOTS30')
    expect(best('mini knots jar', CATALOG)).toBe('KNOTSJAR')
    expect(best('Maxican chilli 30g', CATALOG)).toBe('MEX30')
    expect(best('party pack mexican chilli', CATALOG)).toBe('MEXPP')
    expect(best('Milk chocolate', CATALOG)).toBe('MILK30')
    expect(best('Dill pickles', CATALOG)).toBe('DILL60')
    expect(best('sticks', CATALOG)).toBe('STICKS30')
  })
  it('uses MRP to tell the pouch from the jar', () => {
    expect(best('mini pretzel knots', { POUCH: 'Mini Pretzel Knots', JAR: 'Mini Pretzel Knots' }, 99)).toBe('POUCH')
  })
})

describe('customers', () => {
  it('ignores Pvt Ltd / LLP when comparing names', () => {
    expect(nameSimilarity('Gupta Brands LLP', 'GUPTA BRANDS')).toBe(1)
    expect(nameSimilarity('Foodstories Pvt. Ltd.', 'Food Square')).toBeLessThan(0.5)
  })
  it('checks a GSTIN and gives its state code', () => {
    expect(gstinState('27AAACZ8867B1Z0')).toBe('27')
    expect(gstinState('27AAACZ8867B1')).toBeNull()
  })
})

import { isBulkPack } from '../src/lib/match'
describe('bulk packs', () => {
  it('500 g and 1 kg are bulk; small packs are not', () => {
    expect(isBulkPack('500 g')).toBe(true)
    expect(isBulkPack('Atom Eats Mini Pretzel Sticks, 500g')).toBe(true)
    expect(isBulkPack('1 kg')).toBe(true)
    expect(isBulkPack('Truffle Potato Chips - Pack of 1 · 40 g')).toBe(false)
    expect(isBulkPack(null)).toBe(false)
  })
})
