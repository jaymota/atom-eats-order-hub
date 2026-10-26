import { NavLink, Outlet } from 'react-router-dom'
import { Logo } from '../components/ui'
import { useAuth } from '../lib/auth'
import { ROLE_NAMES } from '../lib/format'

const LINKS = [
  { to: '/', label: 'Home', end: true },
  { to: '/orders/new', label: '+ New order', end: true },
  { to: '/orders', label: 'Orders', end: true },
  { to: '/products', label: 'Products' },
  { to: '/customers', label: 'Customers' },
  { to: '/checks', label: 'Checks' },
  { to: '/team', label: 'Team' },
  { to: '/activity', label: 'Activity' },
  { to: '/my-pin', label: 'My PIN' },
]

export default function Layout() {
  const { me, signOut } = useAuth()
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
          {LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              className={({ isActive }) =>
                `whitespace-nowrap border-b-2 px-3 py-3 text-sm font-semibold ${isActive ? 'border-ae-blue text-ae-blue' : 'border-transparent text-stone-600 hover:text-stone-900'}`
              }
            >
              {l.label}
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
