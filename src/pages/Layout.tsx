import { NavLink, Outlet } from 'react-router-dom'
import { Logo } from '../components/ui'
import { useAuth } from '../lib/auth'
import { ROLE_NAMES } from '../lib/format'
import { useTodoCounts, type TodoCounts } from '../lib/todo'

type L = { to: string; label: string; end?: boolean; count?: keyof TodoCounts; roles?: string[] }
const OPS = ['super_admin', 'admin', 'ops']
const ACC = ['super_admin', 'admin', 'accounts']
const LINKS: L[] = [
  { to: '/', label: 'Home', end: true },
  { to: '/orders/new', label: '+ New order', end: true },
  { to: '/plan', label: 'Plan', count: 'plan', roles: OPS },
  { to: '/invoice', label: 'Invoice', count: 'invoice', roles: ACC },
  { to: '/dispatch', label: 'Dispatch', count: 'dispatch', roles: OPS },
  { to: '/orders', label: 'Orders', end: true },
  { to: '/invoices', label: 'All invoices', roles: ACC },
  { to: '/downloads', label: 'Downloads', roles: [...OPS, 'accounts'] },
  { to: '/products', label: 'Products' },
  { to: '/customers', label: 'Customers' },
  { to: '/checks', label: 'Checks' },
  { to: '/team', label: 'Team' },
  { to: '/activity', label: 'Activity' },
  { to: '/my-pin', label: 'My PIN' },
]

export default function Layout() {
  const { me, signOut } = useAuth()
  const counts = useTodoCounts()
  return (
    <div className="min-h-screen bg-ae-cream">
      <header className="border-b border-ae-blue/15 bg-ae-cream">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Logo className="h-10 shrink-0" />
            <div className="min-w-0">
              <div className="font-bold text-ae-blue">Order Hub</div>
              <div className="truncate text-xs text-stone-600">{me?.name} · {me && ROLE_NAMES[me.role]}</div>
            </div>
          </div>
          <button type="button" onClick={() => signOut('You have logged out.')} className="shrink-0 rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold bg-white text-ae-blue hover:bg-ae-cream/50">
            Log out
          </button>
        </div>
        <nav className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-2">
          {LINKS.filter((l) => !l.roles || l.roles.includes(me?.role ?? '')).map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              className={({ isActive }) =>
                `whitespace-nowrap border-b-2 px-3 py-3 text-sm font-semibold ${isActive ? 'border-ae-blue text-ae-blue' : 'border-transparent text-stone-600 hover:text-stone-900'}`
              }
            >
              {l.label}
              {l.count && counts && counts[l.count] > 0 && <span className="ml-1.5 rounded-full bg-ae-blue px-1.5 py-0.5 text-xs text-ae-cream">{counts[l.count]}</span>}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  )
}
