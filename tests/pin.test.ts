import { describe, expect, it } from 'vitest'
import { lockMinutes, normaliseUsername, pinProblem, randomPin, suggestUsername } from '../supabase/functions/_shared/pin'

describe('PIN rules', () => {
  it('refuses short, repeated, sequential and common PINs', () => {
    expect(pinProblem('12345')).toMatch(/6 to 12/)
    expect(pinProblem('12a456')).toMatch(/6 to 12/)
    expect(pinProblem('111111')).toMatch(/repeated/)
    expect(pinProblem('345678')).toMatch(/sequence/)
    expect(pinProblem('987654')).toMatch(/sequence/)
    expect(pinProblem('890123')).toMatch(/sequence/)
    expect(pinProblem('112233')).toMatch(/easy/)
  })

  it('accepts a normal PIN', () => {
    expect(pinProblem('583920')).toBeNull()
    expect(pinProblem('40917263')).toBeNull()
  })

  it('first PINs are always 6 digits and allowed', () => {
    for (let i = 0; i < 500; i++) {
      const p = randomPin()
      expect(p).toMatch(/^\d{6}$/)
      expect(pinProblem(p)).toBeNull()
    }
  })
})

describe('locks', () => {
  it('doubles each time, capped at a day', () => {
    expect([1, 2, 3, 4].map(lockMinutes)).toEqual([15, 30, 60, 120])
    expect(lockMinutes(20)).toBe(24 * 60)
  })
})

describe('login names', () => {
  it('uses the first name in small letters', () => {
    expect(suggestUsername('Siddhesh Warang ')).toBe('siddhesh')
    expect(suggestUsername('Aanjana')).toBe('aanjana')
  })
  it('ignores case and spaces when logging in', () => {
    expect(normaliseUsername('  Zeeshan ')).toBe('zeeshan')
    expect(normaliseUsername(undefined)).toBe('')
  })
})
