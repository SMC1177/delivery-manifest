import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  doc: vi.fn(),
  getDoc: vi.fn(() => Promise.resolve({ exists: () => false })),
  onSnapshot: vi.fn((q, cb) => {
    cb({ docs: [] })
    return vi.fn()
  }),
}))

vi.mock('../lib/firebase', () => ({
  auth: {},
  db: {},
}))

vi.mock('../hooks/useOrgSettings', () => ({
  useOrgSettings: () => ({
    settings: { enabledFields: ['carrier', 'address', 'notes'] },
    isFieldEnabled: (field) => ['carrier', 'address', 'notes'].includes(field),
  }),
}))

vi.mock('../hooks/useTextMessagingSettings', () => ({
  useTextMessagingSettings: () => ({ data: null, loading: false, save: vi.fn() }),
}))

import ShipmentTable from '../components/ShipmentTable'

function renderWithRouter(ui) {
  return render(
    <MemoryRouter initialEntries={['/test-org/dashboard']}>
      <Routes>
        <Route path="/:slug/dashboard" element={ui} />
      </Routes>
    </MemoryRouter>
  )
}

const mockHandlers = {
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onStatusChange: vi.fn(),
}

describe('ShipmentTable', () => {
  it('shows empty state when no shipments', () => {
    renderWithRouter(<ShipmentTable shipments={[]} {...mockHandlers} />)
    expect(screen.getByText('No shipments found')).toBeInTheDocument()
  })

  it('renders shipment data in the table', () => {
    const shipments = [
      {
        id: '1',
        patientName: 'John Doe',
        date: '2025-06-15',
        rxNumbers: ['RX001', 'RX002'],
        trackingNumber: '1Z999AA1',
        carrier: 'ups',
        status: 'shipped',
        address: '123 Main St',
      },
    ]

    renderWithRouter(<ShipmentTable shipments={shipments} {...mockHandlers} />)

    expect(screen.getAllByText('John Doe').length).toBeGreaterThan(0)
    expect(screen.getAllByText('RX001, RX002').length).toBeGreaterThan(0)
    expect(screen.getAllByText('1Z999AA1').length).toBeGreaterThan(0)
  })

  it('renders UPS tracking link correctly', () => {
    const shipments = [
      {
        id: '1',
        patientName: 'UPS Patient',
        trackingNumber: '1Z999AA1',
        carrier: 'ups',
        status: 'shipped',
        rxNumbers: [],
      },
    ]

    renderWithRouter(<ShipmentTable shipments={shipments} {...mockHandlers} />)

    const links = screen.getAllByRole('link', { name: '1Z999AA1' })
    expect(links.length).toBeGreaterThan(0)
    expect(links[0].href).toContain('ups.com/track')
  })

  it('renders FedEx tracking link correctly', () => {
    const shipments = [
      {
        id: '2',
        patientName: 'FedEx Patient',
        trackingNumber: '789456123012',
        carrier: 'fedex',
        status: 'in_transit',
        rxNumbers: [],
      },
    ]

    renderWithRouter(<ShipmentTable shipments={shipments} {...mockHandlers} />)

    const links = screen.getAllByRole('link', { name: '789456123012' })
    expect(links.length).toBeGreaterThan(0)
    expect(links[0].href).toContain('fedex.com/fedextrack')
  })

  it('displays carrier name instead of raw value', () => {
    const shipments = [
      {
        id: '1',
        patientName: 'Test Patient',
        trackingNumber: '123',
        carrier: 'fedex',
        status: 'pending',
        rxNumbers: [],
      },
    ]

    renderWithRouter(<ShipmentTable shipments={shipments} {...mockHandlers} />)

    // Should show "FedEx" not "fedex"
    expect(screen.getAllByText('FedEx').length).toBeGreaterThan(0)
  })

  it('shows dash for missing tracking number', () => {
    const shipments = [
      {
        id: '1',
        patientName: 'No Tracking',
        trackingNumber: '',
        carrier: 'ups',
        status: 'pending',
        rxNumbers: [],
      },
    ]

    renderWithRouter(<ShipmentTable shipments={shipments} {...mockHandlers} />)

    // Should render dash characters for missing data
    const dashes = screen.getAllByText('—')
    expect(dashes.length).toBeGreaterThan(0)
  })
})

describe('ShipmentTable exception reason rendering', () => {
  const renderShipments = (shipments) =>
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<ShipmentTable shipments={shipments} />} />
        </Routes>
      </MemoryRouter>
    )

  // Every shipment renders TWICE - once as a desktop table row, once as a
  // mobile card - so text appears twice and the singular queries throw.
  // toHaveLength(2) is deliberate: it proves BOTH views show the reason, which
  // a toBeGreaterThan(0) check would not, and staff here work on tablets.

  it('shows the upsStatus reason for an exception shipment', () => {
    const { getAllByText } = renderShipments([
      { id: 'exception-1', status: 'exception', carrier: 'ups', upsStatus: 'Receiver was not available', fedexStatus: null }
    ])

    expect(getAllByText('Receiver was not available')).toHaveLength(2)
  })

  it('shows the fedexStatus fallback reason for an exception shipment', () => {
    const { getAllByText } = renderShipments([
      { id: 'exception-2', status: 'exception', carrier: 'fedex', upsStatus: null, fedexStatus: 'Delivery exception' }
    ])

    expect(getAllByText('Delivery exception')).toHaveLength(2)
  })

  it('does not render a reason node when an exception shipment has neither reason field', () => {
    const { getAllByText, queryAllByText, container } = renderShipments([
      { id: 'exception-3', status: 'exception', carrier: 'ups', upsStatus: null, fedexStatus: null }
    ])

    // The badge still renders in both views...
    expect(getAllByText(/exception/i).length).toBeGreaterThan(0)
    // ...but no reason text does.
    expect(queryAllByText('Receiver was not available')).toHaveLength(0)
    expect(queryAllByText('Delivery exception')).toHaveLength(0)
    // Bound to the class the component actually uses. The previous version of
    // this line guessed at .exception-reason / [class*="reason"], which the
    // implementation never emits, so it could not fail either way.
    expect(container.querySelectorAll('.text-red-700')).toHaveLength(0)
  })

  it('does not show a populated upsStatus for a delivered shipment', () => {
    const { queryAllByText } = renderShipments([
      { id: 'delivered-1', status: 'delivered', carrier: 'ups', upsStatus: 'Receiver was not available' }
    ])

    expect(queryAllByText('Receiver was not available')).toHaveLength(0)
  })

  it('shows the reason even when carrier is null but upsStatus is populated', () => {
    const { getAllByText } = renderShipments([
      { id: 'exception-5', status: 'exception', carrier: null, upsStatus: 'Receiver was not available', fedexStatus: null }
    ])

    expect(getAllByText('Receiver was not available')).toHaveLength(2)
  })
})
