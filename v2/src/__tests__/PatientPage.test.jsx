// RED spec for v2/src/pages/PatientPage.jsx — that page does NOT exist yet,
// so this suite must fail to load (Cannot find module ...).
// Acceptance contract: blank -> type-to-narrow search over patient rows,
// grouped from useShipments via the patientGrouping utils, master-detail
// (click row -> PatientProfile, Back returns). PURE VIEW, never writes.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import PatientPage from '../pages/PatientPage'

const { mockShipments } = vi.hoisted(() => ({
  mockShipments: [
    { id: 'a1', patientName: 'Jane Smith', patientNameLower: 'jane smith', phone: '+1-555-0100', dob: '1980-01-01', address: '200 Maple Blvd', date: '2025-06-15', status: 'delivered', rxNumbers: ['RX-300'], trackingNumber: '1Z999AA1', carrier: 'ups', facilityName: 'Northside Pharmacy' },
    { id: 'a2', patientName: 'jane smith', patientNameLower: 'jane smith', phone: '+1-555-0100', dob: '1980-01-01', address: '200 Maple Blvd', date: '2025-05-01', status: 'pending', rxNumbers: ['RX-200'], trackingNumber: '', carrier: 'ups', facilityName: 'Northside Pharmacy' },
    { id: 'b1', patientName: 'Maria Garcia', patientNameLower: 'maria garcia', phone: '+1-555-0200', dob: '1975-05-05', address: '88 Oak Ave', date: '2025-06-20', status: 'shipped', rxNumbers: ['RX-010'], trackingNumber: '789456123012', carrier: 'fedex', facilityName: 'City Drug' },
  ],
}))

vi.mock('../hooks/useShipments', () => ({
  useShipments: () => ({ shipments: mockShipments, loading: false, error: null, refresh: vi.fn() }),
}))

vi.mock('../hooks/useSmsContact', () => ({
  useSmsContact: () => ({ contact: null, loading: false, derivedState: 'unknown', normalizedPhone: null }),
}))

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/woodlandsrx/patient']}>
      <Routes>
        <Route path="/:slug/patient" element={<PatientPage />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('PatientPage', () => {
  it('shows a blank prompt before any search text is typed', () => {
    renderPage()
    expect(screen.getByText(/type to search/i)).toBeInTheDocument()
    expect(screen.queryByText('Jane Smith')).toBeNull()
  })

  it('narrows patient rows as the search text is typed', () => {
    renderPage()
    const input = screen.getByPlaceholderText(/search patients/i)
    fireEvent.change(input, { target: { value: 'maria' } })
    expect(screen.getByText('Maria Garcia')).toBeInTheDocument()
    expect(screen.queryByText('Jane Smith')).toBeNull()
  })

  it('groups case-variant names into one patient row with the shipment count', () => {
    renderPage()
    fireEvent.change(screen.getByPlaceholderText(/search patients/i), { target: { value: 'jane' } })
    expect(screen.getByText('Jane Smith')).toBeInTheDocument()
    expect(screen.getByText(/2 shipments?/i)).toBeInTheDocument()
  })

  it('opens the profile when a patient row is clicked and Back returns to the list', () => {
    renderPage()
    fireEvent.change(screen.getByPlaceholderText(/search patients/i), { target: { value: 'jane' } })
    fireEvent.click(screen.getByText('Jane Smith'))
    // Profile shows the tab bar
    expect(screen.getByRole('button', { name: 'Prescriptions & Shipments' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect(screen.getByText('Jane Smith')).toBeInTheDocument()
  })
})
