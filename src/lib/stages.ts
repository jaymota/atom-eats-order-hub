export type Stage = 'new' | 'planned' | 'invoiced' | 'dispatched' | 'delivered' | 'on_hold' | 'cancelled'

export const STAGE_LABEL: Record<Stage, string> = {
  new: 'New',
  planned: 'Planned for dispatch',
  invoiced: 'Invoice shared',
  dispatched: 'Dispatched',
  delivered: 'Delivered',
  on_hold: 'On hold',
  cancelled: 'Cancelled',
}

export const STAGE_TONE: Record<Stage, string> = {
  new: 'bg-sky-100 text-sky-800',
  planned: 'bg-violet-100 text-violet-800',
  invoiced: 'bg-amber-100 text-amber-800',
  dispatched: 'bg-green-100 text-green-800',
  delivered: 'bg-emerald-200 text-emerald-900',
  on_hold: 'bg-stone-200 text-stone-700',
  cancelled: 'bg-red-100 text-red-800',
}

/** Late = not dispatched within 24 hours of the order arriving. */
export function isLate(stage: Stage, receivedAt: string): boolean {
  return ['new', 'planned', 'invoiced', 'on_hold'].includes(stage) && Date.now() - Date.parse(receivedAt) > 24 * 3_600_000
}

/** "5 h", "2 d 3 h" since the order arrived. */
export function age(receivedAt: string): string {
  const h = Math.floor((Date.now() - Date.parse(receivedAt)) / 3_600_000)
  if (h < 1) return '<1 h'
  if (h < 24) return `${h} h`
  return `${Math.floor(h / 24)} d ${h % 24} h`
}

export const rupees = (n: number | null | undefined) =>
  n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
