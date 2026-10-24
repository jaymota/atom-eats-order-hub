export type Role = 'super_admin' | 'admin' | 'accounts' | 'ops' | 'sales'

export const ROLE_NAMES: Record<Role, string> = {
  super_admin: 'Super admin',
  admin: 'Admin',
  accounts: 'Accounts',
  ops: 'Ops / dispatch',
  sales: 'Sales',
}

export const ROLE_HELP: Record<Role, string> = {
  super_admin: 'Everything, including managing admins and settings.',
  admin: 'Everything except managing other admins.',
  accounts: 'Records invoices.',
  ops: 'Plans dispatch, marks orders dispatched, adds tracking. Can also enter orders.',
  sales: 'Enters orders and sees all orders. Can’t move orders between stages.',
}

export const isAdmin = (r: Role | undefined) => r === 'super_admin' || r === 'admin'

/** "24 Oct 2026, 6:42 pm" in India time. */
export function istDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} h ago`
  const days = Math.round(hrs / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
