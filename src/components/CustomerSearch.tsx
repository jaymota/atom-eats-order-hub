// Type a name, phone or code; tap a saved customer.
import { useEffect, useMemo, useState } from 'react'
import { Input } from './ui'
import { nameSimilarity, norm } from '../lib/match'
import { loadCustomersLite } from '../lib/orders'
import type { CustomerLite } from '../lib/resolve'

export default function CustomerSearch({ onPick, placeholder = 'Search party: name, phone, code', autoFocus }: {
  onPick: (c: CustomerLite) => void; placeholder?: string; autoFocus?: boolean
}) {
  const [list, setList] = useState<CustomerLite[]>([])
  const [q, setQ] = useState('')
  useEffect(() => { loadCustomersLite().then((c) => setList(c.list.filter((x) => x.active))) }, [])
  const hits = useMemo(() => {
    const qn = norm(q)
    if (qn.length < 2) return []
    const digits = q.replace(/\D/g, '')
    return list.filter((c) => norm(`${c.name} ${c.code} ${c.billing_city ?? ''}`).includes(qn) || (digits.length >= 5 && (c.phone ?? '').includes(digits))
      || (qn.length >= 4 && nameSimilarity(q, c.name) >= 0.7)).slice(0, 6)
  }, [list, q])
  return (
    <div className="space-y-2">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} />
      {hits.map((c) => (
        <button key={c.id} type="button" onClick={() => { onPick(c); setQ('') }}
          className="block w-full rounded-xl border-2 border-stone-200 bg-white px-4 py-3 text-left font-semibold active:bg-ae-blue/5">
          {c.name}<div className="text-sm font-normal text-stone-500">{[c.code, c.billing_city].filter(Boolean).join(' · ')}</div>
        </button>
      ))}
    </div>
  )
}
