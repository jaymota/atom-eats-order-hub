// Small shared building blocks: big, clear buttons and fields that work well on a phone.
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'

type Tone = 'primary' | 'plain' | 'danger'

const TONES: Record<Tone, string> = {
  primary: 'bg-ae-blue text-ae-cream hover:bg-ae-blue-dark disabled:bg-ae-blue/40',
  plain: 'bg-white text-stone-800 border border-stone-300 hover:bg-ae-cream/50 disabled:text-stone-400',
  danger: 'bg-white text-red-700 border border-red-300 hover:bg-red-50 disabled:text-red-300',
}

export function Button({ tone = 'primary', className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }) {
  return (
    <button
      type="button"
      {...rest}
      className={`min-h-12 rounded-lg px-5 text-base font-semibold transition-colors disabled:cursor-not-allowed ${TONES[tone]} ${className}`}
    />
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-semibold text-stone-700">{label}</span>
      {hint && <span className="block text-xs text-stone-500">{hint}</span>}
      <div className="mt-1">{children}</div>
    </label>
  )
}

const inputCls = 'w-full min-h-12 rounded-lg border border-stone-300 bg-white px-3 text-base text-stone-900 focus:border-ae-blue focus:outline-none focus:ring-2 focus:ring-ae-blue/20'

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputCls} ${props.className ?? ''}`} />
}

export function PinInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Input
      type="password"
      inputMode="numeric"
      autoComplete="off"
      maxLength={12}
      {...props}
      onChange={(e) => {
        e.target.value = e.target.value.replace(/\D/g, '')
        props.onChange?.(e)
      }}
      className="tracking-[0.4em] text-lg"
    />
  )
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputCls} ${props.className ?? ''}`} />
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5 ${className}`}>{children}</div>
}

export function ErrorBox({ children }: { children: ReactNode }) {
  if (!children) return null
  return <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{children}</p>
}

export function OkBox({ children }: { children: ReactNode }) {
  if (!children) return null
  return <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">{children}</p>
}

export function Badge({ children, tone = 'stone' }: { children: ReactNode; tone?: 'stone' | 'amber' | 'red' | 'green' }) {
  const c = { stone: 'bg-stone-100 text-stone-700', amber: 'bg-ae-yellow text-ae-blue', red: 'bg-red-100 text-red-800', green: 'bg-green-100 text-green-800' }[tone]
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${c}`}>{children}</span>
}

// The Atom Eats logo, served from the atomeats.com Shopify store.
const LOGO_URL = 'https://atomeats.com/cdn/shop/files/AtomEats_Logo.png?v=1729704984&width=320'

export function Logo({ className = 'h-10' }: { className?: string }) {
  return <img src={LOGO_URL} alt="Atom Eats" className={`w-auto ${className}`} />
}
