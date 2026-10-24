import { useState, type FormEvent } from 'react'
import { Button, Card, ErrorBox, Field, Input, OkBox, PinInput } from '../components/ui'
import { useAuth } from '../lib/auth'
import { callFn, supabase } from '../lib/supabase'

const LAST_NAME = 'order-hub-login-name'

interface LoginResult {
  session: { access_token: string; refresh_token: string }
  mustChangePin: boolean
}

function lockText(until: string) {
  const t = new Date(until).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })
  return ` Try again after ${t}.`
}

export default function Login({ onFirstPin }: { onFirstPin: (pin: string) => void }) {
  const { notice, refreshMe } = useAuth()
  const [mode, setMode] = useState<'login' | 'forgot' | 'reset'>('login')
  const [username, setUsername] = useState(() => {
    try { return localStorage.getItem(LAST_NAME) ?? '' } catch { return '' }
  })
  const [pin, setPin] = useState('')
  const [code, setCode] = useState('')
  const [newPin, setNewPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  const startSession = async (r: LoginResult) => {
    await supabase.auth.setSession(r.session)
    try { localStorage.setItem(LAST_NAME, username.trim().toLowerCase()) } catch { /* private mode */ }
    await refreshMe()
  }

  const run = (fn: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    setInfo('')
    try {
      await fn()
    } catch (err) {
      const data = (err as { data?: { lockedUntil?: string } }).data
      setError((err as Error).message + (data?.lockedUntil ? lockText(data.lockedUntil) : ''))
    } finally {
      setBusy(false)
    }
  }

  const login = run(async () => {
    const r = await callFn<LoginResult>('auth', { action: 'login', username, pin })
    if (r.mustChangePin) onFirstPin(pin)
    setPin('')
    await startSession(r)
  })

  const askCode = run(async () => {
    const r = await callFn<{ message: string }>('auth', { action: 'request_reset_code', username })
    setInfo(r.message)
    setMode('reset')
  })

  const reset = run(async () => {
    if (newPin.length < 6) throw new Error('Your new PIN must be 6 to 12 digits.')
    const r = await callFn<LoginResult>('auth', { action: 'reset_pin', username, code, pin: newPin })
    await startSession(r)
  })

  return (
    <main className="flex min-h-screen items-start justify-center bg-amber-50 px-4 pt-16 sm:items-center sm:pt-0">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-2xl font-bold text-stone-800">Atom Eats Order Hub</h1>
        <p className="mb-6 mt-1 text-center text-sm text-stone-500">For the Atom Eats team only</p>
        <Card>
          {mode === 'login' && (
            <form onSubmit={login} className="space-y-4">
              {notice && <OkBox>{notice}</OkBox>}
              <Field label="Your name" hint="Your first name, e.g. zeeshan">
                <Input value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" autoCorrect="off" autoComplete="username" required />
              </Field>
              <Field label="PIN">
                <PinInput value={pin} onChange={(e) => setPin(e.target.value)} autoFocus={!!username} required />
              </Field>
              <ErrorBox>{error}</ErrorBox>
              <Button type="submit" disabled={busy || !username || pin.length < 6} className="w-full">
                {busy ? 'Checking…' : 'Log in'}
              </Button>
              <button type="button" onClick={() => { setMode('forgot'); setError('') }} className="w-full py-2 text-sm text-stone-600 underline">
                Forgot PIN?
              </button>
            </form>
          )}

          {mode === 'forgot' && (
            <form onSubmit={askCode} className="space-y-4">
              <p className="text-sm text-stone-600">
                The quickest way: ask an admin to give you a new PIN from the Team page.
              </p>
              <p className="text-sm text-stone-600">Or get a code by email, sent to the email address on your profile:</p>
              <Field label="Your name">
                <Input value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" autoCorrect="off" required />
              </Field>
              <ErrorBox>{error}</ErrorBox>
              <Button type="submit" disabled={busy || !username} className="w-full">{busy ? 'Sending…' : 'Email me a code'}</Button>
              <button type="button" onClick={() => { setMode('login'); setError('') }} className="w-full py-2 text-sm text-stone-600 underline">Back to login</button>
            </form>
          )}

          {mode === 'reset' && (
            <form onSubmit={reset} className="space-y-4">
              <OkBox>{info}</OkBox>
              <Field label="Code from the email">
                <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} inputMode="numeric" maxLength={6} required />
              </Field>
              <Field label="Choose a new PIN" hint="6 to 12 digits. Not 123456, not the same digit repeated.">
                <PinInput value={newPin} onChange={(e) => setNewPin(e.target.value)} required />
              </Field>
              <ErrorBox>{error}</ErrorBox>
              <Button type="submit" disabled={busy || code.length !== 6 || newPin.length < 6} className="w-full">{busy ? 'Saving…' : 'Save PIN and log in'}</Button>
              <button type="button" onClick={() => { setMode('login'); setError('') }} className="w-full py-2 text-sm text-stone-600 underline">Back to login</button>
            </form>
          )}
        </Card>
      </div>
    </main>
  )
}
