import { useState } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import type { ReactNode } from 'react'
import { AuthProvider, useAuth } from './lib/auth'
import { homeFor, mayOpen } from './lib/access'
import Activity from './pages/Activity'
import Checks from './pages/Checks'
import Customers from './pages/Customers'
import Downloads from './pages/Downloads'
import ChoosePin from './pages/ChoosePin'
import Home from './pages/Home'
import Inbox from './pages/Inbox'
import Invoices from './pages/Invoices'
import Layout from './pages/Layout'
import Login from './pages/Login'
import NewOrder from './pages/NewOrder'
import OrderPage from './pages/OrderPage'
import Orders from './pages/Orders'
import Products from './pages/Products'
import Team from './pages/Team'
import { DispatchPage, InvoicePage, PlanPage } from './pages/Todo'

/** A page the person's role may not open sends them to their own start page. */
function Only({ path, children }: { path: string; children: ReactNode }) {
  const { me } = useAuth()
  return mayOpen(path, me?.role) ? <>{children}</> : <Navigate to={homeFor(me?.role)} replace />
}

function Gate() {
  const { loading, session, me } = useAuth()
  // The first PIN typed at login, kept in memory only, so they don't have to type it twice.
  const [firstPin, setFirstPin] = useState('')

  if (loading) return <div className="p-8 text-center text-stone-500">Loading…</div>
  if (!session || !me) return <Login onFirstPin={setFirstPin} />
  if (me.must_change_pin) return <ChoosePin first firstPin={firstPin || undefined} />

  return (
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Only path="/"><Home /></Only>} />
          <Route path="orders" element={<Only path="/orders"><Orders /></Only>} />
          <Route path="orders/new" element={<Only path="/orders/new"><NewOrder /></Only>} />
          <Route path="orders/:id" element={<Only path="/orders/:id"><OrderPage /></Only>} />
          <Route path="inbox" element={<Only path="/inbox"><Inbox /></Only>} />
          <Route path="plan" element={<Only path="/plan"><PlanPage /></Only>} />
          <Route path="invoice" element={<Only path="/invoice"><InvoicePage /></Only>} />
          <Route path="dispatch" element={<Only path="/dispatch"><DispatchPage /></Only>} />
          <Route path="invoices" element={<Only path="/invoices"><Invoices /></Only>} />
          <Route path="downloads" element={<Only path="/downloads"><Downloads /></Only>} />
          <Route path="products" element={<Only path="/products"><Products /></Only>} />
          <Route path="customers" element={<Only path="/customers"><Customers /></Only>} />
          <Route path="checks" element={<Only path="/checks"><Checks /></Only>} />
          <Route path="team" element={<Only path="/team"><Team /></Only>} />
          <Route path="activity" element={<Only path="/activity"><Activity /></Only>} />
          <Route path="my-pin" element={<Only path="/my-pin"><ChoosePin first={false} /></Only>} />
          <Route path="*" element={<Navigate to={homeFor(me.role)} replace />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}
