/**
 * Tracking Number Grouping Tests
 *
 * Tests the ShipmentTable grouping logic: rows sharing the same tracking
 * number collapse into one row with expand/collapse and merged Rx display.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
    settings: { enabledFields: ['carrier', 'notes'] },
    isFieldEnabled: (field) => ['carrier', 'notes'].includes(field),
  }),
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

const handlers = {
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onStatusChange: vi.fn(),
}

describe('ShipmentTable — tracking number grouping', () => {
  it('groups shipments with the same tracking number', () => {
    const shipments = [
      { id: '1', patientName: 'Alice', trackingNumber: '1Z999AA1', carrier: 'ups', status: 'pending', rxNumbers: ['RX001'] },
      { id: '2', patientName: 'Alice', trackingNumber: '1Z999AA1', carrier: 'ups', status: 'pending', rxNumbers: ['RX002'] },
      { id: '3', patientName: 'Bob', trackingNumber: '1Z888BB2', carrier: 'ups', status: 'shipped', rxNumbers: ['RX003'] },
    ]

    renderWithRouter(<ShipmentTable shipments={shipments} {...handlers} />)

    // Desktop table: Alice should appear once as primary (grouped), Bob once
    // The +1 badge should indicate a child
    const aliceRows = screen.getAllByText('Alice')
    // Alice appears in desktop + mobile = at least 1, but not 4 (ungrouped would be 4)
    expect(aliceRows.length).toBeLessThanOrEqual(3)

    const badge = screen.getAllByText('+1')
    expect(badge.length).toBeGreaterThan(0)
  })

  it('shows merged Rx numbers on the primary grouped row', () => {
    const shipments = [
      { id: '1', patientName: 'Alice', trackingNumber: '1Z999AA1', carrier: 'ups', status: 'pending', rxNumbers: ['RX001'] },
      { id: '2', patientName: 'Alice', trackingNumber: '1Z999AA1', carrier: 'ups', status: 'pending', rxNumbers: ['RX002'] },
    ]

    renderWithRouter(<ShipmentTable shipments={shipments} {...handlers} />)

    // Primary row should show merged: RX001, RX002
    const mergedRx = screen.getAllByText('RX001, RX002')
    expect(mergedRx.length).toBeGreaterThan(0)
  })

  it('deduplicates Rx numbers in merged display', () => {
    const shipments = [
      { id: '1', patientName: 'Alice', trackingNumber: '1Z999AA1', carrier: 'ups', status: 'pending', rxNumbers: ['RX001', 'RX002'] },
      { id: '2', patientName: 'Alice', trackingNumber: '1Z999AA1', carrier: 'ups', status: 'pending', rxNumbers: ['RX002', 'RX003'] },
    ]

    renderWithRouter(<ShipmentTable shipments={shipments} {...handlers} />)

    // Should show RX001, RX002, RX003 (not RX002 twice)
    const mergedRx = screen.getAllByText('RX001, RX002, RX003')
    expect(mergedRx.length).toBeGreaterThan(0)
  })

  it('does not group shipments without tracking numbers', () => {
    const shipments = [
      { id: '1', patientName: 'Alice', trackingNumber: '', carrier: 'ups', status: 'pending', rxNumbers: ['RX001'] },
      { id: '2', patientName: 'Bob', trackingNumber: '', carrier: 'ups', status: 'pending', rxNumbers: ['RX002'] },
    ]

    renderWithRouter(<ShipmentTable shipments={shipments} {...handlers} />)

    // Both should render independently — no badge
    expect(screen.queryByText('+1')).toBeNull()
  })

  it('groups case-insensitively', () => {
    const shipments = [
      { id: '1', patientName: 'Alice', trackingNumber: '1Z999AA1', carrier: 'ups', status: 'pending', rxNumbers: ['RX001'] },
      { id: '2', patientName: 'Alice', trackingNumber: '1z999aa1', carrier: 'ups', status: 'pending', rxNumbers: ['RX002'] },
    ]

    renderWithRouter(<ShipmentTable shipments={shipments} {...handlers} />)

    // Should group — +1 badge present
    const badge = screen.getAllByText('+1')
    expect(badge.length).toBeGreaterThan(0)
  })

  it('shows correct badge count for multiple children', () => {
    const shipments = [
      { id: '1', patientName: 'Alice', trackingNumber: '1Z999AA1', carrier: 'ups', status: 'pending', rxNumbers: ['RX001'] },
      { id: '2', patientName: 'Alice', trackingNumber: '1Z999AA1', carrier: 'ups', status: 'pending', rxNumbers: ['RX002'] },
      { id: '3', patientName: 'Alice', trackingNumber: '1Z999AA1', carrier: 'ups', status: 'pending', rxNumbers: ['RX003'] },
    ]

    renderWithRouter(<ShipmentTable shipments={shipments} {...handlers} />)

    const badge = screen.getAllByText('+2')
    expect(badge.length).toBeGreaterThan(0)
  })

  it('standalone shipment (unique tracking) renders without badge', () => {
    const shipments = [
      { id: '1', patientName: 'Solo', trackingNumber: '1ZUNIQUE', carrier: 'ups', status: 'pending', rxNumbers: ['RX001'] },
    ]

    renderWithRouter(<ShipmentTable shipments={shipments} {...handlers} />)

    expect(screen.queryByText('+1')).toBeNull()
    expect(screen.queryByText('+0')).toBeNull()
    expect(screen.getAllByText('Solo').length).toBeGreaterThan(0)
  })
})
