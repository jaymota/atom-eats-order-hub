// PIN rules, shared by the server and the tests. No Deno or browser imports here.

const WEAK_PINS = new Set([
  '123456', '654321', '123123', '112233', '121212', '123321', '696969', '159753', '147258', '100200',
  '987654', '012345', '1234567', '12345678', '123456789', '11223344', '22446688', '13579246',
])

/** Returns a friendly reason the PIN can't be used, or null if it's fine. */
export function pinProblem(pin: unknown): string | null {
  if (typeof pin !== 'string' || !/^\d{6,12}$/.test(pin)) return 'Your PIN must be 6 to 12 digits.'
  if (/^(\d)\1+$/.test(pin)) return 'Please don’t use the same digit repeated.'
  const digits = pin.split('').map(Number)
  const asc = digits.every((d, i) => i === 0 || d === (digits[i - 1] + 1) % 10)
  const desc = digits.every((d, i) => i === 0 || d === (digits[i - 1] + 9) % 10)
  if (asc || desc) return 'Please don’t use a sequence like 123456.'
  if (WEAK_PINS.has(pin)) return 'That PIN is too easy to guess. Please choose another.'
  return null
}

/** A random 6-digit first PIN that passes the rules. */
export function randomPin(): string {
  for (;;) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000
    const pin = String(n).padStart(6, '0')
    if (!pinProblem(pin)) return pin
  }
}

/** Lock length after the Nth lock in a row: 15 min, 30, 60 … up to 24 hours. */
export function lockMinutes(level: number): number {
  return Math.min(15 * 2 ** Math.max(0, level - 1), 24 * 60)
}

/** "Siddhesh Warang" → "siddhesh". Lowercase letters, digits and dots only. */
export function suggestUsername(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? ''
  return first.toLowerCase().normalize('NFKD').replace(/[^a-z0-9.]/g, '')
}

export function normaliseUsername(u: unknown): string {
  return typeof u === 'string' ? u.trim().toLowerCase() : ''
}

export const ROLES = ['super_admin', 'admin', 'accounts', 'ops', 'sales'] as const
export type Role = (typeof ROLES)[number]
