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

export const COURIERS = ['DTDC', 'Porter', 'Customer pickup', 'Other'] as const

/** Who may do what (the database checks this too). */
export const can = {
  plan: (r?: string) => ['super_admin', 'admin', 'ops'].includes(r ?? ''),
  invoice: (r?: string) => ['super_admin', 'admin', 'accounts'].includes(r ?? ''),
  dispatch: (r?: string) => ['super_admin', 'admin', 'ops'].includes(r ?? ''),
}

/** Today in India, as yyyy-mm-dd. */
export const todayIST = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10)

/** Puts a file in the order's folder and records it. */
export async function attachFile(orderId: string, file: Blob & { name?: string }, kind: string) {
  const { supabase } = await import('./supabase')
  const name = (file.name ?? 'file').replace(/[^\w.-]+/g, '-').slice(0, 50)
  const path = `${orderId}/${Date.now()}-${name}`
  const up = await supabase.storage.from('order-files').upload(path, file, { contentType: file.type || undefined })
  if (up.error) throw new Error(up.error.message)
  const { error } = await supabase.rpc('add_order_file', { p_order: orderId, p_path: path, p_kind: kind, p_name: file.name ?? name, p_size: file.size })
  if (error) throw new Error(error.message)
}

/** Sends the hand-off email. Never blocks the work if email isn't set up. */
export async function notify(kind: 'planned' | 'invoiced' | 'dispatched', ids: string[]) {
  try {
    const { callFn } = await import('./supabase')
    await callFn('notify', { kind, ids })
  } catch { /* email is a nice-to-have */ }
}
