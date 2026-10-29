import { useState } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
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
          <Route index element={<Home />} />
          <Route path="orders" element={<Orders />} />
          <Route path="orders/new" element={<NewOrder />} />
          <Route path="orders/:id" element={<OrderPage />} />
          <Route path="inbox" element={<Inbox />} />
          <Route path="plan" element={<PlanPage />} />
          <Route path="invoice" element={<InvoicePage />} />
          <Route path="dispatch" element={<DispatchPage />} />
          <Route path="invoices" element={<Invoices />} />
          <Route path="downloads" element={<Downloads />} />
          <Route path="products" element={<Products />} />
          <Route path="customers" element={<Customers />} />
          <Route path="checks" element={<Checks />} />
          <Route path="team" element={<Team />} />
          <Route path="activity" element={<Activity />} />
          <Route path="my-pin" element={<ChoosePin first={false} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
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
