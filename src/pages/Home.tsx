// Phase 1 home: a welcome and what this person's role can do. The order pipeline arrives in later phases.
import { Link } from 'react-router-dom'
import { Card } from '../components/ui'
import { useAuth } from '../lib/auth'
import { ROLE_HELP, ROLE_NAMES } from '../lib/format'

export default function Home() {
  const { me } = useAuth()
  if (!me) return null
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-ae-blue">Hello, {me.name.split(' ')[0]}</h2>
      <Card>
        <div className="text-sm text-stone-500">Your role</div>
        <div className="text-lg font-semibold text-ae-blue">{ROLE_NAMES[me.role]}</div>
        <p className="mt-1 text-sm text-stone-600">{ROLE_HELP[me.role]}</p>
      </Card>
      <Card className="border-dashed bg-ae-yellow/20">
        <p className="text-sm text-stone-700">
          Orders, the order form and the to-do lists are being built next. For now you can see the <Link to="/team" className="font-semibold text-ae-blue underline">team</Link> and
          the <Link to="/activity" className="font-semibold text-ae-blue underline">activity log</Link>.
        </p>
      </Card>
    </div>
  )
}
