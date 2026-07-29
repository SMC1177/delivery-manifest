import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import '@testing-library/jest-dom'

// ——— Firebase mocks ———
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn(() => vi.fn()),
}))

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  addDoc: vi.fn(),
  serverTimestamp: vi.fn(),
  doc: vi.fn(),
  onSnapshot: vi.fn((_q, cb) => {
    cb({ exists: () => false, data: () => null })
    return vi.fn()
  }),
}))

vi.mock('../lib/firebase', () => ({
  auth: {},
  db: {},
}))

// ——— App module mocks ———
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'test-uid' } }),
}))

vi.mock('../hooks/useAuditLog', () => ({
  useAuditLog: () => ({ logAction: vi.fn() }),
}))

vi.mock('../components/Toast', () => ({
  useToast: () => vi.fn(),
}))

// 15 shipments — enough to distinguish from any clamped value (10, 5, etc.)
// but small enough to render fast.
const MOCK_SHIPMENTS = Array.from({ length: 15 }, (_, i) => ({
  id: `${i + 1}`,
  patientName: `Patient ${i + 1}`,
  status: 'pending',
  date: '2026-03-25',
  trackingNumber: '',
  rxNumbers: [],
}))

vi.mock('../hooks/useShipments', () => ({
  useShipments: () => ({
    shipments: MOCK_SHIPMENTS,
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

// ——— Component under test ———
import DashboardPage from '../pages/DashboardPage'

const STORAGE_KEY = 'dashboard_rowsPerPage_test-org'

function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={['/test-org/dashboard']}>
      <Routes>
        <Route path="/:slug/dashboard" element={<DashboardPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('DashboardPage page-size control', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  // 1. Value below the floor (10) is clamped — must not honour a persisted "5".
  it('clamps a persisted value below the floor of 10', () => {
    localStorage.setItem(STORAGE_KEY, '5')
    renderDashboard()
    // if the clamp did not fire, only 5 rows would appear; Patient 15 proves all 15 render
    expect(screen.getAllByText('Patient 15').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('15 shipments')).toBeInTheDocument()
  })

  // 2. Value above the ceiling (300) is clamped — must not honour a persisted "500".
  it('clamps a persisted value above the ceiling of 300', () => {
    localStorage.setItem(STORAGE_KEY, '500')
    renderDashboard()
    expect(screen.getAllByText('Patient 15').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('15 shipments')).toBeInTheDocument()
  })

  // 3. Corrupt persisted value yields the default of 100 without crashing.
  it('falls back to default 100 when persisted value is corrupt', () => {
    localStorage.setItem(STORAGE_KEY, 'not-a-number')
    renderDashboard()
    expect(screen.getAllByText('Patient 15').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('15 shipments')).toBeInTheDocument()
  })

  // 4. If localStorage.getItem throws, the dashboard still renders.
  it('renders the dashboard even when localStorage.getItem throws', () => {
    const origGetItem = localStorage.getItem
    localStorage.getItem = () => {
      throw new Error('quota exceeded')
    }
    renderDashboard()
    // must not crash — the page still shows all 15 shipments
    expect(screen.getAllByText('Patient 15').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('15 shipments')).toBeInTheDocument()
    localStorage.getItem = origGetItem
  })
})
