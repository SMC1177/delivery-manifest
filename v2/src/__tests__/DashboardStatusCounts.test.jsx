import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// Mock Firebase modules before importing the component
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn(() => vi.fn()),
}))

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  addDoc: vi.fn(),
  serverTimestamp: vi.fn(),
  doc: vi.fn(),
  onSnapshot: vi.fn((q, cb) => {
    cb({ exists: () => false, data: () => null })
    return vi.fn()
  }),
}))

vi.mock('../lib/firebase', () => ({
  auth: {},
  db: {},
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'test-uid' } }),
}))

vi.mock('../hooks/useAuditLog', () => ({
  useAuditLog: () => ({ logAction: vi.fn() }),
}))

vi.mock('../components/Toast', () => ({
  useToast: () => vi.fn(),
}))

const mockShipments = [
  { id: '1', patientName: 'A', status: 'pending', date: '2026-03-25', trackingNumber: '', rxNumbers: [] },
  { id: '2', patientName: 'B', status: 'pending', date: '2026-03-25', trackingNumber: '', rxNumbers: [] },
  { id: '3', patientName: 'C', status: 'shipped', date: '2026-03-25', trackingNumber: '', rxNumbers: [] },
  { id: '4', patientName: 'D', status: 'delivered', date: '2026-03-25', trackingNumber: '', rxNumbers: [] },
  { id: '5', patientName: 'E', status: 'delivered', date: '2026-03-25', trackingNumber: '', rxNumbers: [] },
  { id: '6', patientName: 'F', status: 'delivered', date: '2026-03-25', trackingNumber: '', rxNumbers: [] },
]

vi.mock('../hooks/useShipments', () => ({
  useShipments: () => ({
    shipments: mockShipments,
    loading: false,
    error: null,
    addShipment: vi.fn(),
    updateShipment: vi.fn(),
    removeShipment: vi.fn(),
  }),
  getCentralTimeDateString: () => '2026-03-25',
  formatCentralTime: (v) => v,
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

import DashboardPage from '../pages/DashboardPage'

function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={['/test-org/dashboard']}>
      <Routes>
        <Route path="/:slug/dashboard" element={<DashboardPage />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('DashboardPage status filter counts', () => {
  it('shows total count on All button', () => {
    renderDashboard()
    // Use exact: true to avoid matching "All dates" button
    const allButtons = screen.getAllByRole('button', { name: /^All\b/ })
    const allFilterButton = allButtons.find((btn) => btn.textContent.match(/^All\s*\(/))
    expect(allFilterButton).toBeTruthy()
    expect(allFilterButton.textContent).toContain('(6)')
  })

  it('shows per-status counts on filter buttons', () => {
    renderDashboard()
    const pendingButton = screen.getByRole('button', { name: /^Pending/ })
    expect(pendingButton.textContent).toContain('(2)')

    const shippedButton = screen.getByRole('button', { name: /^Shipped/ })
    expect(shippedButton.textContent).toContain('(1)')

    const deliveredButton = screen.getByRole('button', { name: /^Delivered/ })
    expect(deliveredButton.textContent).toContain('(3)')
  })

  it('hides count for statuses with zero shipments', () => {
    renderDashboard()
    const exceptionButton = screen.getByRole('button', { name: /^Exception/ })
    expect(exceptionButton.textContent).toBe('Exception')
  })
})
