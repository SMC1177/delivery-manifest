import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

// This suite owns its own firebase/firestore mock, like its siblings.
// where/orderBy/limit return tagged objects so tests can assert the exact
// constraint set handed to query() — plain vi.fn()s would all return
// undefined and make the boundedness assertions vacuous (a fence that
// cannot fail is no fence).
vi.mock('firebase/firestore', () => {
  const getDocs = vi.fn()
  const collection = vi.fn()
  const query = vi.fn()
  const where = vi.fn((...args) => ({ kind: 'where', args }))
  const orderBy = vi.fn((...args) => ({ kind: 'orderBy', args }))
  const limit = vi.fn((...args) => ({ kind: 'limit', args }))
  return { getDocs, collection, query, where, orderBy, limit }
})

vi.mock('../lib/firebase', () => ({
  db: {},
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'u1' }, orgSlug: 'acme' }),
}))

import { useFacilityShipments } from '../hooks/useFacilityShipments'
import { getDocs, query, limit } from 'firebase/firestore'

const FACILITY = 'North Side Clinic'

describe('useFacilityShipments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('costs zero reads when no facility is selected (null)', () => {
    const { result } = renderHook(() => useFacilityShipments('acme', null, null))
    expect(getDocs).not.toHaveBeenCalled()
    expect(result.current.shipments).toEqual([])
    expect(result.current.loading).toBe(false)
  })

  it('costs zero reads when the facility name is empty', () => {
    const { result } = renderHook(() => useFacilityShipments('acme', '', null))
    expect(getDocs).not.toHaveBeenCalled()
    expect(result.current.shipments).toEqual([])
    expect(result.current.loading).toBe(false)
  })

  it('builds a bounded server-side query: filters, date bounds, sort, and an explicit limit', async () => {
    getDocs.mockResolvedValue({ docs: [] })
    const { result } = renderHook(() =>
      useFacilityShipments('acme', FACILITY, { from: '2026-06-01', to: '2026-06-30' })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(getDocs).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledTimes(1)

    // First query() arg is the collection ref; the rest are the constraints.
    const constraints = query.mock.calls[0].slice(1)

    expect(constraints).toContainEqual({ kind: 'where', args: ['archived', '==', false] })
    expect(constraints).toContainEqual({ kind: 'where', args: ['facilityName', '==', FACILITY] })
    expect(constraints).toContainEqual({ kind: 'where', args: ['date', '>=', '2026-06-01'] })
    expect(constraints).toContainEqual({ kind: 'where', args: ['date', '<=', '2026-06-30'] })
    expect(constraints).toContainEqual({ kind: 'orderBy', args: ['date', 'desc'] })

    // THE FENCE: the dashboard's existing pattern loads ALL 28,257 rows
    // client-side and is growing ~7k/week (open defect S4). Re-shipping that
    // pattern here would be the blank-screen bug again. An unbounded facility
    // query is S4 re-shipped; this assertion is the fence that stops the
    // boundedness from eroding — no explicit positive limit means no query.
    expect(limit).toHaveBeenCalledTimes(1)
    const pageSize = limit.mock.calls[0][0]
    expect(Number.isFinite(pageSize)).toBe(true)
    expect(pageSize).toBeGreaterThan(0)
    expect(
      constraints.some((c) => c.kind === 'limit' && Number.isFinite(c.args[0]) && c.args[0] > 0)
    ).toBe(true)
  })

  it('sorts shipments ascending by patientNameLower (last-name-first, native to the field)', async () => {
    const docs = [
      { id: 'c', data: () => ({ patientNameLower: 'suci, sarah' }) },
      { id: 'a', data: () => ({ patientNameLower: 'mccormick, david' }) },
      { id: 'b', data: () => ({ patientNameLower: 'connelly, shannon a' }) },
    ]
    getDocs.mockResolvedValue({ docs })
    const { result } = renderHook(() => useFacilityShipments('acme', FACILITY, null))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.shipments.map((s) => s.patientNameLower)).toEqual([
      'connelly, shannon a',
      'mccormick, david',
      'suci, sarah',
    ])
  })

  it('sets error when getDocs rejects — never an empty-looking success', async () => {
    getDocs.mockRejectedValueOnce(new Error('Network error'))
    const { result } = renderHook(() => useFacilityShipments('acme', FACILITY, null))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBe('Network error')
    expect(result.current.shipments).toEqual([])
    expect(result.current.loading).toBe(false)
  })

  it('re-queries with the new equality value when the facility selection changes', async () => {
    getDocs.mockResolvedValue({ docs: [] })
    const { result, rerender } = renderHook(
      ({ facilityName }) => useFacilityShipments('acme', facilityName, null),
      { initialProps: { facilityName: 'North Side Clinic' } }
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(getDocs).toHaveBeenCalledTimes(1)

    rerender({ facilityName: 'South Side Clinic' })
    await waitFor(() => expect(getDocs).toHaveBeenCalledTimes(2))

    const facilityNameConstraints = query.mock.calls.map((call) =>
      call.slice(1).find((c) => c.kind === 'where' && c.args[0] === 'facilityName')
    )
    expect(facilityNameConstraints.map((c) => c.args)).toEqual([
      ['facilityName', '==', 'North Side Clinic'],
      ['facilityName', '==', 'South Side Clinic'],
    ])
  })
})
