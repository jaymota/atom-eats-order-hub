// The team list. Everyone can see it; admins can add people, edit them, give new first PINs and switch people off.
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Badge, Button, Card, ErrorBox, Field, Input, Select } from '../components/ui'
import { useAuth } from '../lib/auth'
import { ROLE_HELP, ROLE_NAMES, ago, isAdmin, type Role } from '../lib/format'
import { callFn, supabase } from '../lib/supabase'

interface Person {
  id: string
  name: string
  username: string
  role: Role
  email: string | null
  phone: string | null
  active: boolean
  must_change_pin: boolean
  last_login_at: string | null
}

const ROLE_ORDER: Role[] = ['super_admin', 'admin', 'accounts', 'ops', 'sales']

function suggestUsername(name: string) {
  return (name.trim().split(/\s+/)[0] ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9.]/g, '')
}

/** Shows a first PIN once, big, so the admin can pass it on. */
function PinNotice({ name, pin, onClose }: { name: string; pin: string; onClose: () => void }) {
  return (
    <Card className="border-amber-300 bg-amber-50">
      <p className="text-sm text-stone-700">First PIN for <b>{name}</b>. Give it to them in person or by phone. It won’t be shown again.</p>
      <p className="my-3 text-center font-mono text-4xl font-bold tracking-[0.3em] text-stone-900">{pin}</p>
      <p className="mb-3 text-xs text-stone-600">They log in with their name and this PIN, then choose their own PIN straight away.</p>
      <Button tone="plain" className="w-full" onClick={onClose}>Done, I’ve noted it</Button>
    </Card>
  )
}

function PersonForm({ initial, roles, onSave, onCancel, saveLabel }: {
  initial: Partial<Person>
  roles: Role[]
  onSave: (p: Partial<Person>) => Promise<void>
  onCancel: () => void
  saveLabel: string
}) {
  const [name, setName] = useState(initial.name ?? '')
  const [username, setUsername] = useState(initial.username ?? '')
  const [usernameTouched, setUsernameTouched] = useState(!!initial.username)
  const [role, setRole] = useState<Role | ''>(initial.role ?? '')
  const [email, setEmail] = useState(initial.email ?? '')
  const [phone, setPhone] = useState(initial.phone ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onSave({ name, username, role: role as Role, email, phone })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <Field label="Full name">
        <Input value={name} required onChange={(e) => {
          setName(e.target.value)
          if (!usernameTouched) setUsername(suggestUsername(e.target.value))
        }} />
      </Field>
      <Field label="Login name" hint="What they type to log in. Small letters, no spaces.">
        <Input value={username} required autoCapitalize="none" autoCorrect="off" onChange={(e) => { setUsername(e.target.value.toLowerCase()); setUsernameTouched(true) }} />
      </Field>
      <Field label="Role" hint={role ? ROLE_HELP[role] : undefined}>
        <Select value={role} required disabled={!roles.length} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="" disabled>Choose…</option>
          {(roles.includes(role as Role) || !role ? roles : [role as Role, ...roles]).map((r) => <option key={r} value={r}>{ROLE_NAMES[r]}</option>)}
        </Select>
      </Field>
      <Field label="Email" hint="For notifications and PIN reset codes. Can be shared.">
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" />
      </Field>
      <Field label="Phone (optional)">
        <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
      <div className="sm:col-span-2 space-y-3">
        <ErrorBox>{error}</ErrorBox>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : saveLabel}</Button>
          <Button tone="plain" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </form>
  )
}

export default function Team() {
  const { me } = useAuth()
  const [people, setPeople] = useState<Person[]>([])
  const [locked, setLocked] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [pinShown, setPinShown] = useState<{ name: string; pin: string } | null>(null)
  const [error, setError] = useState('')

  const admin = isAdmin(me?.role)
  const isSuper = me?.role === 'super_admin'
  const mayManage = (r: Role) => isSuper || (admin && r !== 'super_admin' && r !== 'admin')
  const assignable = ROLE_ORDER.filter((r) => mayManage(r))

  const load = useCallback(async () => {
    const { data } = await supabase.from('people').select('id, name, username, role, email, phone, active, must_change_pin, last_login_at').order('name')
    setPeople(((data ?? []) as Person[]).sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.name.localeCompare(b.name)))
    if (admin) {
      const { data: l } = await supabase.rpc('locked_people')
      setLocked(Object.fromEntries(((l ?? []) as { person_id: string; locked_until: string }[]).map((r) => [r.person_id, r.locked_until])))
    }
  }, [admin])

  useEffect(() => { load() }, [load])

  const act = async (body: Record<string, unknown>, after?: (r: { firstPin?: string }) => void) => {
    setError('')
    try {
      const r = await callFn<{ firstPin?: string }>('team', body)
      after?.(r)
      await load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const visible = people.filter((p) => p.active)
  const switchedOff = people.filter((p) => !p.active)

  const row = (p: Person) => {
    const canManage = mayManage(p.role) && p.id !== me?.id
    return (
      <li key={p.id} className="px-4 py-4">
        {editing === p.id ? (
          <PersonForm
            initial={p}
            roles={assignable}
            saveLabel="Save changes"
            onCancel={() => setEditing(null)}
            onSave={async (v) => {
              await callFn('team', { action: 'update', id: p.id, ...v })
              setEditing(null)
              await load()
            }}
          />
        ) : (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-stone-900">{p.name}</span>
                <Badge tone={isAdmin(p.role) ? 'amber' : 'stone'}>{ROLE_NAMES[p.role]}</Badge>
                {locked[p.id] && <Badge tone="red">Locked</Badge>}
                {!p.active && <Badge tone="red">Switched off</Badge>}
                {p.active && p.must_change_pin && <Badge>Hasn’t chosen own PIN yet</Badge>}
              </div>
              <div className="mt-1 text-sm text-stone-600">
                Login name: <span className="font-mono">{p.username}</span>
                {p.email && <> · {p.email}</>}
                {p.phone && <> · {p.phone}</>}
              </div>
              <div className="text-xs text-stone-500">Last login: {ago(p.last_login_at)}</div>
            </div>
            {canManage && (
              <div className="flex flex-wrap gap-2">
                <Button tone="plain" className="min-h-10 px-3 text-sm" onClick={() => setEditing(p.id)}>Edit</Button>
                {p.active && (
                  <Button tone="plain" className="min-h-10 px-3 text-sm" onClick={() => {
                    if (confirm(`Give ${p.name} a new first PIN? Their old PIN stops working and they are logged out.`)) {
                      act({ action: 'reset_pin', id: p.id }, (r) => r.firstPin && setPinShown({ name: p.name, pin: r.firstPin }))
                    }
                  }}>New PIN</Button>
                )}
                {locked[p.id] && <Button tone="plain" className="min-h-10 px-3 text-sm" onClick={() => act({ action: 'unlock', id: p.id })}>Unlock</Button>}
                {p.active ? (
                  <Button tone="danger" className="min-h-10 px-3 text-sm" onClick={() => {
                    if (confirm(`Switch off ${p.name}? They are logged out and can’t log in. Their history stays.`)) act({ action: 'update', id: p.id, active: false })
                  }}>Switch off</Button>
                ) : (
                  <Button tone="plain" className="min-h-10 px-3 text-sm" onClick={() => act({ action: 'update', id: p.id, active: true })}>Switch on</Button>
                )}
              </div>
            )}
          </div>
        )}
      </li>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-bold text-stone-800">Team</h2>
        {admin && !adding && <Button onClick={() => { setAdding(true); setPinShown(null) }}>+ Add a person</Button>}
      </div>

      {pinShown && <PinNotice name={pinShown.name} pin={pinShown.pin} onClose={() => setPinShown(null)} />}
      <ErrorBox>{error}</ErrorBox>

      {adding && (
        <Card>
          <h3 className="mb-4 font-semibold text-stone-800">Add a person</h3>
          <PersonForm
            initial={{}}
            roles={assignable}
            saveLabel="Add and make first PIN"
            onCancel={() => setAdding(false)}
            onSave={async (v) => {
              const r = await callFn<{ firstPin: string }>('team', { action: 'add', ...v })
              setAdding(false)
              setPinShown({ name: v.name ?? '', pin: r.firstPin })
              await load()
            }}
          />
        </Card>
      )}

      <Card className="p-0 sm:p-0">
        <ul className="divide-y divide-stone-100">{visible.map(row)}</ul>
      </Card>

      {switchedOff.length > 0 && (
        <>
          <h3 className="pt-2 text-sm font-semibold text-stone-500">Switched off</h3>
          <Card className="p-0 sm:p-0"><ul className="divide-y divide-stone-100">{switchedOff.map(row)}</ul></Card>
        </>
      )}
    </div>
  )
}
