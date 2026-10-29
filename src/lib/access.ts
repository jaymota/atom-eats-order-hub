// Who sees which page. Sales (field sales) only enters orders; Accounts only sees invoices and dispatch.
// The database enforces the same limits, so a hidden page can't be reached by typing its address.
const TEAM = ['super_admin', 'admin', 'ops']
const ACC = ['super_admin', 'admin', 'accounts']
const ALL = [...TEAM, 'accounts', 'sales']

export const PAGE_ROLES: Record<string, string[]> = {
  '/': TEAM,
  '/orders/new': [...TEAM, 'sales'],
  '/inbox': TEAM,
  '/plan': TEAM,
  '/invoice': ACC,
  '/dispatch': [...TEAM, 'accounts'],
  '/orders': TEAM,
  '/invoices': ACC,
  '/downloads': TEAM,
  '/products': TEAM,
  '/customers': TEAM,
  '/checks': TEAM,
  '/team': TEAM,
  '/activity': TEAM,
  '/my-pin': ALL,
  '/orders/:id': ALL, // sales only gets the orders they entered (database rule)
}

export const mayOpen = (path: string, role?: string) => (PAGE_ROLES[path] ?? TEAM).includes(role ?? '')

/** Where each login lands. */
export const homeFor = (role?: string) => (role === 'sales' ? '/orders/new' : role === 'accounts' ? '/invoice' : '/')
