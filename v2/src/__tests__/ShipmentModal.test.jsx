import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// Mock dependencies
vi.mock('react-router-dom', () => ({
  useParams: () => ({ slug: 'test-org' }),
}))

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

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ orgSlug: 'test-org', user: { uid: 'test-user' } }),
}))

vi.mock('../hooks/useOrgSettings', () => ({
  useOrgSettings: () => ({
    settings: { enabledFields: ['carrier', 'address', 'phone', 'notes'] },
    isFieldEnabled: (field) => ['carrier', 'address', 'phone', 'notes'].includes(field),
  }),
}))

import ShipmentModal from '../components/ShipmentModal'

describe('ShipmentModal', () => {
  const mockOnClose = vi.fn()
  const mockOnSubmit = vi.fn(() => Promise.resolve())

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not render when isOpen is false', () => {
    const { container } = render(
      <ShipmentModal isOpen={false} onClose={mockOnClose} onSubmit={mockOnSubmit} />
    )
    expect(container.innerHTML).toBe('')
  })

  it('renders the add form when isOpen is true', () => {
    render(
      <ShipmentModal isOpen={true} onClose={mockOnClose} onSubmit={mockOnSubmit} />
    )
    expect(screen.getByText('Add New Shipment')).toBeInTheDocument()
    expect(screen.getByText(/Patient Name/)).toBeInTheDocument()
  })

  it('shows Edit title when shipment is provided', () => {
    const shipment = {
      patientName: 'John Doe',
      trackingNumber: '1Z123',
      carrier: 'ups',
      status: 'pending',
      rxNumbers: ['RX001'],
    }
    render(
      <ShipmentModal
        isOpen={true}
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
        shipment={shipment}
      />
    )
    expect(screen.getByText('Edit Shipment')).toBeInTheDocument()
  })

  it('shows carrier dropdown with UPS and FedEx', () => {
    render(
      <ShipmentModal isOpen={true} onClose={mockOnClose} onSubmit={mockOnSubmit} />
    )
    // Find the carrier select by its name attribute
    const carrierSelect = document.querySelector('select[name="carrier"]')
    expect(carrierSelect).toBeTruthy()

    const options = carrierSelect.querySelectorAll('option')
    const values = Array.from(options).map((o) => o.value)
    expect(values).toContain('ups')
    expect(values).toContain('fedex')
  })

  it('updates tracking label when carrier changes to FedEx', () => {
    render(
      <ShipmentModal isOpen={true} onClose={mockOnClose} onSubmit={mockOnSubmit} />
    )

    // Default is UPS
    expect(screen.getByText(/UPS Tracking Number/)).toBeInTheDocument()

    // Change carrier to FedEx
    const carrierSelect = document.querySelector('select[name="carrier"]')
    fireEvent.change(carrierSelect, { target: { value: 'fedex' } })

    expect(screen.getByText(/FedEx Tracking Number/)).toBeInTheDocument()
  })

  it('updates tracking placeholder when carrier changes', () => {
    render(
      <ShipmentModal isOpen={true} onClose={mockOnClose} onSubmit={mockOnSubmit} />
    )

    // Default UPS placeholder
    expect(screen.getByPlaceholderText('1Z999AA...')).toBeInTheDocument()

    // Change to FedEx
    const carrierSelect = document.querySelector('select[name="carrier"]')
    fireEvent.change(carrierSelect, { target: { value: 'fedex' } })

    expect(screen.getByPlaceholderText('7489...')).toBeInTheDocument()
  })

  it('calls onSubmit with form data', async () => {
    render(
      <ShipmentModal isOpen={true} onClose={mockOnClose} onSubmit={mockOnSubmit} />
    )

    const nameInput = document.querySelector('input[name="patientName"]')
    const carrierSelect = document.querySelector('select[name="carrier"]')
    const trackingInput = document.querySelector('input[name="trackingNumber"]')

    fireEvent.change(nameInput, { target: { value: 'Jane Doe' } })
    fireEvent.change(carrierSelect, { target: { value: 'fedex' } })
    fireEvent.change(trackingInput, { target: { value: '789456123012' } })

    fireEvent.click(screen.getByText('Add Shipment'))

    await waitFor(() => {
      expect(mockOnSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          patientName: 'Jane Doe',
          carrier: 'fedex',
          trackingNumber: '789456123012',
        })
      )
    })
  })

  it('calls onClose when Cancel is clicked', () => {
    render(
      <ShipmentModal isOpen={true} onClose={mockOnClose} onSubmit={mockOnSubmit} />
    )
    fireEvent.click(screen.getByText('Cancel'))
    expect(mockOnClose).toHaveBeenCalled()
  })

  it('populates form with shipment data when editing', () => {
    const shipment = {
      patientName: 'Test Patient',
      trackingNumber: '789456',
      carrier: 'fedex',
      status: 'shipped',
      rxNumbers: ['RX100', 'RX200'],
      address: '456 Oak Ave',
    }

    render(
      <ShipmentModal
        isOpen={true}
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
        shipment={shipment}
      />
    )

    expect(document.querySelector('input[name="patientName"]').value).toBe('Test Patient')
    expect(document.querySelector('input[name="trackingNumber"]').value).toBe('789456')
    expect(document.querySelector('select[name="carrier"]').value).toBe('fedex')
    expect(document.querySelector('select[name="status"]').value).toBe('shipped')
  })
})
