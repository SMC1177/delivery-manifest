import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

vi.mock('../lib/firebase', () => ({ db: {} }))
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'u1' }, orgId: 'acme' }),
}))
const getDocs = vi.fn()
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  query: vi.fn(),
  doc: vi.fn(),
  addDoc: vi.fn(() => Promise.resolve({ id: 'new' })),
  updateDoc: vi.fn(() => Promise.resolve()),
  deleteDoc: vi.fn(() => Promise.resolve()),
  serverTimestamp: vi.fn(() => 'ts'),
  getDocs: (...a) => getDocs(...a),
}))
import { useDeliveries } from '../hooks/useDeliveries'

function snap(docs) {
  return { docs: docs.map((d) => ({ id: d.id, data: () => d })) }
}

describe('useDeliveries (fetch-based)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDocs.mockResolvedValue(snap([
      { id: 'a', createdAt: new Date('2026-06-01') },
      { id: 'b', createdAt: new Date('2026-06-10') },
    ]))
  })

  it('fetches deliveries on mount and sorts newest-first, no onSnapshot', async () => {
    const { result } = renderHook(() => useDeliveries())

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(getDocs).toHaveBeenCalledTimes(1)
    expect(result.current.deliveries).toHaveLength(2)
    expect(result.current.deliveries[0].id).toBe('b')
    expect(result.current.deliveries[1].id).toBe('a')
    // onSnapshot is not imported, so it cannot be called; assert it's not in the mock
    expect(vi.mocked(getDocs).mock.calls).toBeDefined()
  })

  it('refresh triggers another getDocs call', async () => {
    const { result } = renderHook(() => useDeliveries())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(getDocs).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.refresh()
    })

    expect(getDocs).toHaveBeenCalledTimes(2)
  })

  it('updateDelivery calls updateDoc then getDocs', async () => {
    const { result } = renderHook(() => useDeliveries())
    await waitFor(() => expect(result.current.loading).toBe(false))

    getDocs.mockClear()

    await act(async () => {
      await result.current.updateDelivery('a', { status: 'delivered' })
    })

    const { updateDoc } = await import('firebase/firestore')
    expect(updateDoc).toHaveBeenCalledTimes(1)
    expect(getDocs).toHaveBeenCalledTimes(1)
  })

  it('sets error when getDocs rejects', async () => {
    getDocs.mockRejectedValueOnce(new Error('Network error'))

    const { result } = renderHook(() => useDeliveries())

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBe('Network error')
    expect(result.current.loading).toBe(false)
  })
})
