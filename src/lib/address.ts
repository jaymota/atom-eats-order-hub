// Splits address lines from a message into street / city / state / PIN.
import { GST_STATES } from './match'

const STATE_NAMES = Object.values(GST_STATES)

/** The state a PIN code belongs to (by its first digits). Good enough to fill "state". */
export function pinState(pin: string): string {
  const p = pin.replace(/\D/g, '')
  if (p.length !== 6) return ''
  const n3 = Number(p.slice(0, 3))
  const n2 = Number(p.slice(0, 2))
  if (n3 >= 403 && n3 <= 403) return 'Goa'
  const ranges: [number, number, string][] = [
    [11, 11, 'Delhi'], [12, 13, 'Haryana'], [14, 16, 'Punjab'], [17, 17, 'Himachal Pradesh'], [18, 19, 'Jammu and Kashmir'],
    [20, 28, 'Uttar Pradesh'], [30, 34, 'Rajasthan'], [36, 39, 'Gujarat'], [40, 44, 'Maharashtra'], [45, 48, 'Madhya Pradesh'],
    [49, 49, 'Chhattisgarh'], [50, 50, 'Telangana'], [51, 53, 'Andhra Pradesh'], [56, 59, 'Karnataka'], [60, 66, 'Tamil Nadu'],
    [67, 69, 'Kerala'], [70, 74, 'West Bengal'], [75, 77, 'Odisha'], [78, 78, 'Assam'], [80, 85, 'Bihar'],
  ]
  return ranges.find(([a, b]) => n2 >= a && n2 <= b)?.[2] ?? ''
}

export function splitAddress(lines: string[], nameFirst: boolean): { name: string; address: string; city: string; state: string; pin: string } {
  let ls = lines.map((l) => l.trim().replace(/[,;]+$/, '')).filter(Boolean)
  let name = ''
  if (nameFirst && ls.length > 1 && !/\d/.test(ls[0])) { name = ls[0]; ls = ls.slice(1) }
  const joined = ls.join(', ')
  const pinM = /(?<!\d)([1-9]\d{2}\s?\d{3})(?!\d)/.exec(joined)
  const pin = pinM?.[1].replace(/\s/g, '') ?? ''
  const newDelhi = /\bnew delhi\b/i.test(joined)
  const named = newDelhi ? '' : STATE_NAMES.find((s) => new RegExp(`\\b${s}\\b`, 'i').test(joined)) ?? ''
  const state = named || pinState(pin)
  // Street part: everything before the PIN, without the state and the city at the end
  // ("…, Lower Parel, Mumbai, Maharashtra 400013" → street "…, Lower Parel", city "Mumbai").
  let street = pinM ? joined.slice(0, pinM.index) : joined
  if (newDelhi) {
    street = street.replace(/[,\s-]*\bnew delhi\b[,\s-]*$/i, '')
    return { name, address: street.replace(/[,\s-]+$/, ''), city: 'New Delhi', state: 'Delhi', pin }
  }
  if (named) street = street.replace(new RegExp(`[,\\s-]*\\b${named}\\b[,\\s-]*$`, 'i'), '')
  street = street.replace(/[,\s-]+$/, '')
  const parts = street.split(',').map((x) => x.trim()).filter(Boolean)
  let city = ''
  const last = parts[parts.length - 1] ?? ''
  const lastWords = last.split(/\s+/)
  if (parts.length > 1 && !/\d/.test(last) && lastWords.length <= 3) { city = last; parts.pop() }
  else if (/^[A-Za-z]+$/.test(lastWords[lastWords.length - 1] ?? '') && lastWords.length > 1 && pinM) {
    // "Mumbai 400013" on its own line: the word before the PIN is the city
    city = lastWords.pop()!
    parts[parts.length - 1] = lastWords.join(' ')
  }
  return { name, address: parts.filter(Boolean).join(', '), city, state, pin }
}

