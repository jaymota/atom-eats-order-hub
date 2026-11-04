import { describe, expect, it } from 'vitest'
import { matchOrder, trackingFrom } from '../src/lib/labels'

const open = [
  { id: 1, name: '#13349', customer: 'Nishith Eedula', city: 'Hyderabad' },
  { id: 2, name: '#13351', customer: 'Arushi Thapar', city: 'Mumbai' },
  { id: 3, name: '#13357', customer: 'Ananya Anand', city: 'Mumbai' },
]

describe('trackingFrom', () => {
  it('prefers the barcode', () => {
    expect(trackingFrom(['7X123927480'], 'TX123927480')).toEqual({ tracking: '7X123927480', from: 'barcode' })
  })
  it('ignores product barcodes and falls back to the text', () => {
    expect(trackingFrom(['8906123456789'], 'Tel. 9727797962\n7X123927478')).toEqual({ tracking: '7X123927478', from: 'text' })
  })
  it('fixes common misreads and skips phones and GSTINs', () => {
    expect(trackingFrom([], 'GSTIN: 27ACAFA7039D1ZP Tel 08510020300 TX123927475')?.tracking).toBe('7X123927475')
    expect(trackingFrom([], 'X123927476')?.tracking).toBe('7X123927476')
  })
  it('finds nothing in plain text', () => {
    expect(trackingFrom([], 'Atom Foods LLP Mumbai')).toBeNull()
  })
})

describe('matchOrder', () => {
  it('is sure with the invoice number and name', () => {
    expect(matchOrder('Invoice No.\n13349\nNishith Eedu\nHyderabad', open)).toEqual({ order: open[0], sure: true })
  })
  it('is unsure when only the city fits', () => {
    expect(matchOrder('Mumbai Pin 400072', open).order).toBeNull()
  })
  it('picks by name when the number is unreadable', () => {
    const m = matchOrder('Arushi Thapar Raheja Vistas Mumbai', open)
    expect(m.order?.id).toBe(2)
    expect(m.sure).toBe(true)
  })
})

describe('matchOrder never guesses', () => {
  it('leaves a half-read name for the team to pick', () => {
    expect(matchOrder('rushi That Atom Foods LLP', open).sure).toBe(false)
  })
})
