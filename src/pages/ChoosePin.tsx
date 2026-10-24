// Used twice: straight after logging in with a first PIN (must choose your own),
// and from "My PIN" to change it any time.
import { useState, type FormEvent } from 'react'
import { Button, Card, ErrorBox, Field, OkBox, PinInput } from '../components/ui'
import { useAuth } from '../lib/auth'
import { callFn } from '../lib/supabase'

export default function ChoosePin({ firstPin, first }: { firstPin?: string; first: boolean }) {
  const { me, refreshMe, signOut } = useAuth()
  const [oldPin, setOldPin] = useState(firstPin ?? '')
  const [pin, setPin] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    if (pin !== again) return setError('The two new PINs don’t match.')
    setBusy(true)
    try {
      await callFn('auth', { action: 'change_pin', oldPin, newPin: pin })
      setOldPin('')
      setPin('')
      setAgain('')
      setDone(true)
      if (first) await refreshMe()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const form = (
    <form onSubmit={save} className="space-y-4">
      {done && <OkBox>Your PIN has been changed.</OkBox>}
      {!firstPin && (
        <Field label={first ? 'The first PIN you were given' : 'Your current PIN'}>
          <PinInput value={oldPin} onChange={(e) => setOldPin(e.target.value)} required />
        </Field>
      )}
      <Field label="New PIN" hint="6 to 12 digits. Not 123456, not the same digit repeated. Don’t share it.">
        <PinInput value={pin} onChange={(e) => setPin(e.target.value)} required autoFocus={!!firstPin} />
      </Field>
      <Field label="New PIN again">
        <PinInput value={again} onChange={(e) => setAgain(e.target.value)} required />
      </Field>
      <ErrorBox>{error}</ErrorBox>
      <Button type="submit" disabled={busy || pin.length < 6 || again.length < 6 || oldPin.length < 6} className="w-full">
        {busy ? 'Saving…' : 'Save my PIN'}
      </Button>
    </form>
  )

  if (!first) {
    return (
      <div className="mx-auto max-w-sm space-y-4">
        <h2 className="text-xl font-bold text-stone-800">My PIN</h2>
        <Card>{form}</Card>
        <Card>
          <p className="mb-3 text-sm text-stone-600">Lost a phone, or logged in on someone else’s computer? This logs you out everywhere, including here.</p>
          <Button tone="danger" className="w-full" onClick={async () => {
            await callFn('auth', { action: 'logout_everywhere' }).catch(() => {})
            await signOut('You were logged out on every device.')
          }}>Log out on every device</Button>
        </Card>
      </div>
    )
  }

  return (
    <main className="flex min-h-screen items-start justify-center bg-amber-50 px-4 pt-16 sm:items-center sm:pt-0">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-2xl font-bold text-stone-800">Welcome, {me?.name}</h1>
        <p className="mb-6 mt-1 text-center text-sm text-stone-600">Please choose your own PIN. Only you will know it.</p>
        <Card>{form}</Card>
        <button type="button" onClick={() => signOut()} className="mt-4 w-full py-2 text-sm text-stone-600 underline">Cancel and log out</button>
      </div>
    </main>
  )
}
