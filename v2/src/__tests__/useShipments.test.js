import { describe, it, expect, vi, beforeEach } from 'vitest'

// Keep references to mock functions so tests can control behavior
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
    // Immediately call with empty snapshot
    onNext({ docs: [] })
    return vi.fn() // unsubscribe
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

// Import after mocks are set up
const { useShipments, getCentralTimeDateString } = await import('../hooks/useShipments')

// We need renderHook to test hooks
import { renderHook, act } from '@testing-library/react'

describe('useShipments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('addShipment - duplicate detection', () => {
    it('creates a new shipment when no duplicates exist', async () => {
      // No existing tracking match
      mockGetDocs.mockResolvedValueOnce({ empty: true })
      // No date/Rx overlap
      mockGetDocs.mockResolvedValueOnce({ empty: false, docs: [] })

      mockAddDoc.mockResolvedValueOnce({ id: 'new-doc-id' })

      const { result } = renderHook(() => useShipments('test-org'))

      let addResult
      await act(async () => {
        addResult = await result.current.addShipment({
          patientName: 'John Doe',
          trackingNumber: '1Z999AA1',
          rxNumbers: ['RX001'],
        })
      })

      expect(addResult.id).toBe('new-doc-id')
      expect(addResult.merged).toBe(false)
      expect(addResult.skipped).toBe(false)
      expect(mockAddDoc).toHaveBeenCalled()
    })

    it('skips exact duplicates (same tracking + same Rx)', async () => {
      mockGetDocs.mockResolvedValueOnce({
        empty: false,
        docs: [
          {
            id: 'existing-id',
            data: () => ({
              patientName: 'John Doe',
              rxNumbers: ['RX001'],
              trackingNumber: '1Z999AA1',
            }),
          },
        ],
      })

      const { result } = renderHook(() => useShipments('test-org'))

      let addResult
      await act(async () => {
        addResult = await result.current.addShipment({
          patientName: 'John Doe',
          trackingNumber: '1Z999AA1',
          rxNumbers: ['RX001'],
        })
      })

      expect(addResult.skipped).toBe(true)
      expect(addResult.id).toBe('existing-id')
      expect(mockAddDoc).not.toHaveBeenCalled()
    })

    it('merges new Rx numbers into existing shipment with same tracking', async () => {
      mockGetDocs.mockResolvedValueOnce({
        empty: false,
        docs: [
          {
            id: 'existing-id',
            data: () => ({
              patientName: 'John Doe',
              rxNumbers: ['RX001'],
              trackingNumber: '1Z999AA1',
            }),
          },
        ],
      })

      mockUpdateDoc.mockResolvedValueOnce()

      const { result } = renderHook(() => useShipments('test-org'))

      let addResult
      await act(async () => {
        addResult = await result.current.addShipment({
          patientName: 'John Doe',
          trackingNumber: '1Z999AA1',
          rxNumbers: ['RX001', 'RX002'],
        })
      })

      expect(addResult.merged).toBe(true)
      expect(addResult.id).toBe('existing-id')
      expect(addResult.message).toContain('RX002')
      expect(mockUpdateDoc).toHaveBeenCalled()
      expect(mockAddDoc).not.toHaveBeenCalled()
    })

    it('warns on date + overlapping Rx with different tracking', async () => {
      // No tracking match
      mockGetDocs.mockResolvedValueOnce({ empty: true })
      // Date query returns overlapping Rx
      mockGetDocs.mockResolvedValueOnce({
        empty: false,
        docs: [
          {
            id: 'existing-id',
            data: () => ({
              patientName: 'Jane Doe',
              rxNumbers: ['RX001'],
              trackingNumber: '1Z_DIFFERENT',
              date: getCentralTimeDateString(),
            }),
          },
        ],
      })

      const { result } = renderHook(() => useShipments('test-org'))

      let addResult
      await act(async () => {
        addResult = await result.current.addShipment({
          patientName: 'Jane Doe',
          trackingNumber: '1Z_NEW',
          rxNumbers: ['RX001'],
          date: getCentralTimeDateString(),
        })
      })

      expect(addResult.duplicate).toBe(true)
      expect(addResult.message).toContain('overlapping')
      expect(mockAddDoc).not.toHaveBeenCalled()
    })

    it('creates shipment without tracking number (no duplicate check)', async () => {
      // Date query returns no overlap
      mockGetDocs.mockResolvedValueOnce({ empty: false, docs: [] })

      mockAddDoc.mockResolvedValueOnce({ id: 'new-doc-id' })

      const { result } = renderHook(() => useShipments('test-org'))

      let addResult
      await act(async () => {
        addResult = await result.current.addShipment({
          patientName: 'No Tracking Patient',
          trackingNumber: '',
          rxNumbers: ['RX100'],
        })
      })

      expect(addResult.id).toBe('new-doc-id')
      expect(mockAddDoc).toHaveBeenCalled()
    })
  })

  describe('updateShipment', () => {
    it('sets deliveredAt when status changes to delivered', async () => {
      mockUpdateDoc.mockResolvedValueOnce()

      const { result } = renderHook(() => useShipments('test-org'))

      await act(async () => {
        await result.current.updateShipment('doc-1', { status: 'delivered' })
      })

      const updateCall = mockUpdateDoc.mock.calls[0][1]
      expect(updateCall.status).toBe('delivered')
      expect(updateCall.deliveredAt).toBe('SERVER_TIMESTAMP')
    })

    it('sets shippedAt when status changes to shipped', async () => {
      mockUpdateDoc.mockResolvedValueOnce()

      const { result } = renderHook(() => useShipments('test-org'))

      await act(async () => {
        await result.current.updateShipment('doc-1', { status: 'shipped' })
      })

      const updateCall = mockUpdateDoc.mock.calls[0][1]
      expect(updateCall.status).toBe('shipped')
      expect(updateCall.shippedAt).toBe('SERVER_TIMESTAMP')
    })

    it('does not overwrite existing deliveredAt', async () => {
      mockUpdateDoc.mockResolvedValueOnce()

      const { result } = renderHook(() => useShipments('test-org'))

      await act(async () => {
        await result.current.updateShipment('doc-1', {
          status: 'delivered',
          deliveredAt: 'already-set',
        })
      })

      const updateCall = mockUpdateDoc.mock.calls[0][1]
      expect(updateCall.deliveredAt).toBe('already-set')
    })
  })

  describe('removeShipment', () => {
    it('calls deleteDoc', async () => {
      mockDeleteDoc.mockResolvedValueOnce()

      const { result } = renderHook(() => useShipments('test-org'))

      await act(async () => {
        await result.current.removeShipment('doc-1')
      })

      expect(mockDeleteDoc).toHaveBeenCalled()
    })
  })
})
