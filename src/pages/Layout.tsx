import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { Logo } from '../components/ui'
import { useAuth } from '../lib/auth'
import { ROLE_NAMES } from '../lib/format'
import { useTodoCounts, type TodoCounts } from '../lib/todo'
import { SHORT_MENU, mayOpen } from '../lib/access'

type L = { to: string; label: string; end?: boolean; count?: keyof TodoCounts }
const LINKS: L[] = [
  { to: '/', label: 'Home', end: true },
  { to: '/orders/new', label: '+ New order', end: true },
  { to: '/inbox', label: 'To confirm', count: 'confirm' },
  { to: '/plan', label: 'Plan', count: 'plan' },
  { to: '/invoice', label: 'Invoice', count: 'invoice' },
  { to: '/dispatch', label: 'Dispatch', count: 'dispatch' },
  { to: '/orders', label: 'Orders', end: true },
  { to: '/online', label: 'Online orders' },
  { to: '/invoices', label: 'All invoices' },
  { to: '/downloads', label: 'Easy Ecom Sync' },
  { to: '/needs', label: 'Stock needs' },
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
  const { pathname } = useLocation()
  const [more, setMore] = useState(false)
  const links = LINKS.filter((l) => mayOpen(l.to, me?.role))
  // A short menu (accounts): its own pages first; the rest, or the page you're on, appear after More.
  const short = me ? SHORT_MENU[me.role] : undefined
  const shown = short && !more ? links.filter((l) => short.includes(l.to) || l.to === pathname) : links
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
          {shown.map((l) => (
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
          {short && <button type="button" onClick={() => setMore(!more)} className="whitespace-nowrap border-b-2 border-transparent px-3 py-3 text-sm font-semibold text-stone-500 hover:text-stone-900">{more ? 'Less' : 'More ▾'}</button>}
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  )
}
