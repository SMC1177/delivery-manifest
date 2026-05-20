import { useSmsContact } from '../hooks/useSmsContact'

const STATES = {
  opted_in:  { color: 'bg-green-500',  title: 'Opted in to text messages' },
  pending:   { color: 'bg-yellow-400', title: 'Invite sent — awaiting reply' },
  opted_out: { color: 'bg-red-500',    title: 'Opted out of text messages' },
  unknown:   { color: 'bg-slate-300',  title: 'Never asked about text messages' },
}

export default function OptInDot({ slug, phone, enabled }) {
  const { derivedState } = useSmsContact(slug, phone)
  if (!enabled) return null
  if (derivedState === 'no_phone') return null
  const s = STATES[derivedState] || STATES.unknown
  return (
    <span
      title={s.title}
      className={`inline-block w-2 h-2 rounded-full ${s.color} align-middle`}
      aria-label={s.title}
    />
  )
}
