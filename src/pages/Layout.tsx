import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { ROLE_NAMES } from '../lib/format'

const LINKS = [
  { to: '/', label: 'Home', end: true },
  { to: '/team', label: 'Team' },
  { to: '/activity', label: 'Activity' },
  { to: '/my-pin', label: 'My PIN' },
]

export default function Layout() {
  const { me, signOut } = useAuth()
  return (
    <div className="min-h-screen bg-stone-50">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="font-bold text-stone-800">Atom Eats Order Hub</div>
            <div className="truncate text-xs text-stone-500">{me?.name} · {me && ROLE_NAMES[me.role]}</div>
          </div>
          <button type="button" onClick={() => signOut('You have logged out.')} className="shrink-0 rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50">
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
                `whitespace-nowrap border-b-2 px-3 py-3 text-sm font-semibold ${isActive ? 'border-amber-600 text-amber-700' : 'border-transparent text-stone-600 hover:text-stone-900'}`
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
