/**
 * Rx-Based Dedup Tests
 *
 * Tests tier 3 of the 4-tier duplicate detection in useShipments.addShipment():
 * same patient name + all Rx numbers already exist → skip as duplicate.
 * This catches re-imports from pharmacies that don't include date shipped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetDocs = vi.fn()
const mockAddDoc = vi.fn()
const mockUpdateDoc = vi.fn()
const mockDeleteDoc = vi.fn()

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => 'mock-col-ref'),
  query: vi.fn((...args) => args),
  where: vi.fn((...args) => args),
  getDocs: (...args) => mockGetDocs(...args),
  onSnapshot: vi.fn((q, onNext) => {
    onNext({ docs: [] })
    return vi.fn()
  }),
  addDoc: (...args) => mockAddDoc(...args),
  updateDoc: (...args) => mockUpdateDoc(...args),
  deleteDoc: (...args) => mockDeleteDoc(...args),
  doc: vi.fn(() => 'mock-doc-ref'),
  serverTimestamp: vi.fn(() => 'SERVER_TIMESTAMP'),
  arrayUnion: vi.fn((...args) => args),
}))

vi.mock('../lib/firebase', () => ({
  auth: {},
  db: {},
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ orgSlug: 'test-org', user: { uid: 'test-user' } }),
}))

const { useShipments } = await import('../hooks/useShipments')
import { renderHook, act } from '@testing-library/react'

describe('Rx-based dedup (tier 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips when same patient has all Rx numbers on an existing record', async () => {
    // No tracking match
    mockGetDocs.mockResolvedValueOnce({ empty: true })
    // Patient query finds existing with same Rx
    mockGetDocs.mockResolvedValueOnce({
      docs: [
        {
          id: 'existing-123',
          data: () => ({
            patientName: 'Jane Smith',
            rxNumbers: ['RX100', 'RX101'],
            trackingNumber: '1ZOLD',
          }),
        },
      ],
    })

    const { result } = renderHook(() => useShipments('test-org'))

    let addResult
    await act(async () => {
      addResult = await result.current.addShipment({
        patientName: 'Jane Smith',
        trackingNumber: '1ZNEW',
        rxNumbers: ['RX100', 'RX101'],
      })
    })

    expect(addResult.skipped).toBe(true)
    expect(addResult.message).toContain('same Rx numbers')
    expect(mockAddDoc).not.toHaveBeenCalled()
  })

  it('skips when Rx is a subset of existing record', async () => {
    // No tracking match
    mockGetDocs.mockResolvedValueOnce({ empty: true })
    // Patient has a superset of the new Rx
    mockGetDocs.mockResolvedValueOnce({
      docs: [
        {
          id: 'existing-456',
          data: () => ({
            patientName: 'Jane Smith',
            rxNumbers: ['RX100', 'RX101', 'RX102'],
            trackingNumber: '1ZOLD',
          }),
        },
      ],
    })

    const { result } = renderHook(() => useShipments('test-org'))

    let addResult
    await act(async () => {
      addResult = await result.current.addShipment({
        patientName: 'Jane Smith',
        trackingNumber: '1ZNEW',
        rxNumbers: ['RX100'],
      })
    })

    expect(addResult.skipped).toBe(true)
    expect(mockAddDoc).not.toHaveBeenCalled()
  })

  it('does NOT skip when new Rx numbers are different', async () => {
    // No tracking match
    mockGetDocs.mockResolvedValueOnce({ empty: true })
    // Patient exists but with different Rx
    mockGetDocs.mockResolvedValueOnce({
      docs: [
        {
          id: 'existing-789',
          data: () => ({
            patientName: 'Jane Smith',
            rxNumbers: ['RX999'],
            trackingNumber: '1ZOLD',
          }),
        },
      ],
    })
    // Date check: no overlap
    mockGetDocs.mockResolvedValueOnce({ empty: false, docs: [] })

    mockAddDoc.mockResolvedValueOnce({ id: 'new-doc' })

    const { result } = renderHook(() => useShipments('test-org'))

    let addResult
    await act(async () => {
      addResult = await result.current.addShipment({
        patientName: 'Jane Smith',
        trackingNumber: '1ZNEW',
        rxNumbers: ['RX200'],
      })
    })

    expect(addResult.skipped).toBeFalsy()
    expect(mockAddDoc).toHaveBeenCalled()
  })

  it('does NOT skip when patient name is different', async () => {
    // No tracking match
    mockGetDocs.mockResolvedValueOnce({ empty: true })
    // No patient match (different name)
    mockGetDocs.mockResolvedValueOnce({ docs: [] })
    // Date check: no overlap
    mockGetDocs.mockResolvedValueOnce({ empty: false, docs: [] })

    mockAddDoc.mockResolvedValueOnce({ id: 'new-doc' })

    const { result } = renderHook(() => useShipments('test-org'))

    let addResult
    await act(async () => {
      addResult = await result.current.addShipment({
        patientName: 'Different Person',
        trackingNumber: '1ZNEW',
        rxNumbers: ['RX100'],
      })
    })

    expect(addResult.skipped).toBeFalsy()
    expect(mockAddDoc).toHaveBeenCalled()
  })

  it('skips even without tracking number (no-tracking re-import)', async () => {
    // No tracking number — skips tier 1 tracking check entirely
    // Patient query finds existing with same Rx
    mockGetDocs.mockResolvedValueOnce({
      docs: [
        {
          id: 'existing-no-tn',
          data: () => ({
            patientName: 'No Tracking Patient',
            rxNumbers: ['RX500'],
            trackingNumber: '',
          }),
        },
      ],
    })

    const { result } = renderHook(() => useShipments('test-org'))

    let addResult
    await act(async () => {
      addResult = await result.current.addShipment({
        patientName: 'No Tracking Patient',
        trackingNumber: '',
        rxNumbers: ['RX500'],
      })
    })

    expect(addResult.skipped).toBe(true)
    expect(addResult.message).toContain('same Rx numbers')
    expect(mockAddDoc).not.toHaveBeenCalled()
  })

  it('does not run Rx dedup when no Rx numbers provided', async () => {
    // No tracking match
    mockGetDocs.mockResolvedValueOnce({ empty: true })
    // No Rx → skip patient query, go straight to date check
    // Date check: no overlap (no Rx to overlap with)
    mockAddDoc.mockResolvedValueOnce({ id: 'new-doc' })

    const { result } = renderHook(() => useShipments('test-org'))

    let addResult
    await act(async () => {
      addResult = await result.current.addShipment({
        patientName: 'Empty Rx',
        trackingNumber: '1ZNEW',
        rxNumbers: [],
      })
    })

    expect(addResult.skipped).toBeFalsy()
    expect(mockAddDoc).toHaveBeenCalled()
  })
})
