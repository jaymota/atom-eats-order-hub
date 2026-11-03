// Who sees which page. Sales (field sales) only enters orders; FOC only (marketing) only enters FOC orders;
// Accounts only sees invoices and dispatch.
// The database enforces the same limits, so a hidden page can't be reached by typing its address.
const TEAM = ['super_admin', 'admin', 'manager', 'ops']
const ACC = ['super_admin', 'admin', 'manager', 'accounts']
const ALL = [...TEAM, 'accounts', 'sales', 'marketing']

export const PAGE_ROLES: Record<string, string[]> = {
  '/': TEAM,
  '/orders/new': [...TEAM, 'sales', 'marketing'],
  '/inbox': TEAM,
  '/plan': TEAM,
  '/invoice': ACC,
  '/dispatch': [...TEAM, 'accounts'],
  '/orders': TEAM,
  '/online': TEAM,
  '/invoices': ACC,
  '/downloads': TEAM,
  '/needs': TEAM,
  '/products': TEAM,
  '/customers': TEAM,
  '/checks': TEAM,
  '/team': TEAM,
  '/activity': TEAM,
  '/my-pin': ALL,
  '/orders/:id': ALL, // sales and FOC only get just the orders they entered (database rule)
}

export const mayOpen = (path: string, role?: string) => (PAGE_ROLES[path] ?? TEAM).includes(role ?? '')

/** Where each login lands. */
export const homeFor = (role?: string) => (role === 'sales' || role === 'marketing' ? '/orders/new' : role === 'accounts' || role === 'manager' ? '/invoice' : '/')

/** Menu items always shown to the manager login (accounts); the rest sit under More. */
export const SHORT_MENU: Record<string, string[]> = {
  manager: ['/invoice', '/dispatch', '/orders', '/invoices', '/customers', '/my-pin'],
}
