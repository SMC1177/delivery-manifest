import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SendTextModal from '../components/SendTextModal'

vi.mock('../hooks/useSmsContact', () => ({ useSmsContact: vi.fn() }))
vi.mock('../hooks/useTextMessagingSettings', () => ({ useTextMessagingSettings: vi.fn() }))
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn(),
}))

import { useSmsContact } from '../hooks/useSmsContact'
import { useTextMessagingSettings } from '../hooks/useTextMessagingSettings'
import { httpsCallable } from 'firebase/functions'

beforeEach(() => {
  vi.clearAllMocks()
  useTextMessagingSettings.mockReturnValue({
    data: {
      enabled: true,
      optInPolicy: 'double_opt_in',
      templates: {
        optInInvite: 'YES STOP from {{pharmacyName}}',
        delivered: 'Delivered',
        outForDelivery: 'Out for delivery',
      },
    },
    loading: false,
  })
})

function makeShipment(overrides = {}) {
  return { id: 's1', phone: '(281) 555-0200', patientName: 'John Doe', ...overrides }
}

describe('<SendTextModal />', () => {
  it('renders only opt-in invite button when state is unknown + policy is double_opt_in', () => {
    useSmsContact.mockReturnValue({ derivedState: 'unknown', loading: false, normalizedPhone: '+12815550200' })
    render(<SendTextModal slug="acme" shipment={makeShipment()} onClose={() => {}} />)
    expect(screen.getByRole('button', { name: /send opt-in invite/i })).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /template/i })).not.toBeInTheDocument()
  })

  it('disables all sends when opted_out', () => {
    useSmsContact.mockReturnValue({ derivedState: 'opted_out', loading: false, normalizedPhone: '+12815550200' })
    render(<SendTextModal slug="acme" shipment={makeShipment()} onClose={() => {}} />)
    expect(screen.getByText(/opted out/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument()
  })

  it('shows template dropdown when opted_in', () => {
    useSmsContact.mockReturnValue({ derivedState: 'opted_in', loading: false, normalizedPhone: '+12815550200' })
    render(<SendTextModal slug="acme" shipment={makeShipment()} onClose={() => {}} />)
    expect(screen.getByRole('combobox')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^send$/i })).toBeInTheDocument()
  })

  it('requires consent checkbox in manual_confirm policy', () => {
    useTextMessagingSettings.mockReturnValue({
      data: { enabled: true, optInPolicy: 'manual_confirm', templates: { delivered: 'X' } },
      loading: false,
    })
    useSmsContact.mockReturnValue({ derivedState: 'unknown', loading: false, normalizedPhone: '+12815550200' })
    render(<SendTextModal slug="acme" shipment={makeShipment()} onClose={() => {}} />)
    const send = screen.getByRole('button', { name: /^send$/i })
    expect(send).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /verified consent/i }))
    expect(send).not.toBeDisabled()
  })

  it('calls sendSms callable on send', async () => {
    const call = vi.fn().mockResolvedValue({ data: { ok: true, messageId: 'm1' } })
    httpsCallable.mockReturnValue(call)
    useSmsContact.mockReturnValue({ derivedState: 'opted_in', loading: false, normalizedPhone: '+12815550200' })
    render(<SendTextModal slug="acme" shipment={makeShipment()} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }))
    await vi.waitFor(() => expect(call).toHaveBeenCalled())
    expect(call).toHaveBeenCalledWith({
      orgSlug: 'acme',
      shipmentId: 's1',
      templateKey: expect.any(String),
      consentAffirmed: false,
    })
  })

  it('does not offer Delivered as a manually sendable template', () => {
    useSmsContact.mockReturnValue({ derivedState: 'opted_in', loading: false, normalizedPhone: '+12815550200' })
    render(<SendTextModal slug="acme" shipment={makeShipment()} onClose={() => {}} />)

    const select = screen.getByRole('combobox', { name: /template/i })
    const values = Array.from(select.querySelectorAll('option')).map(o => o.value)

    expect(values).toContain('outForDelivery')
    expect(values.length).toBeGreaterThan(1)
    // A human must not be able to select Delivered.
    expect(values).not.toContain('delivered')
  })
})
