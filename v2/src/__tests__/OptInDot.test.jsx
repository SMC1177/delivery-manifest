import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import OptInDot from '../components/OptInDot'

// Use mutable-object pattern to avoid vi.mock hoisting issues
const smsContact = { impl: () => ({ derivedState: 'unknown', loading: false }) }

vi.mock('../hooks/useSmsContact', () => ({
  useSmsContact: (...args) => smsContact.impl(...args),
}))

describe('<OptInDot />', () => {
  it('renders nothing when phone is empty', () => {
    smsContact.impl = () => ({ derivedState: 'no_phone', loading: false })
    const { container } = render(<OptInDot slug="acme" phone="" enabled={true} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when messaging disabled', () => {
    smsContact.impl = () => ({ derivedState: 'opted_in', loading: false })
    const { container } = render(<OptInDot slug="acme" phone="+1" enabled={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders green dot for opted_in', () => {
    smsContact.impl = () => ({ derivedState: 'opted_in', loading: false })
    render(<OptInDot slug="acme" phone="+12815550200" enabled={true} />)
    const dot = screen.getByTitle(/opted in/i)
    expect(dot.className).toMatch(/green/)
  })

  it('renders yellow dot for pending', () => {
    smsContact.impl = () => ({ derivedState: 'pending', loading: false })
    render(<OptInDot slug="acme" phone="+12815550200" enabled={true} />)
    expect(screen.getByTitle(/awaiting reply/i).className).toMatch(/yellow/)
  })

  it('renders red dot for opted_out', () => {
    smsContact.impl = () => ({ derivedState: 'opted_out', loading: false })
    render(<OptInDot slug="acme" phone="+12815550200" enabled={true} />)
    expect(screen.getByTitle(/opted out/i).className).toMatch(/red/)
  })

  it('renders grey dot for unknown', () => {
    smsContact.impl = () => ({ derivedState: 'unknown', loading: false })
    render(<OptInDot slug="acme" phone="+12815550200" enabled={true} />)
    expect(screen.getByTitle(/never asked/i).className).toMatch(/slate|gray|grey/)
  })
})
