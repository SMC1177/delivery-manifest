import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

// Mock firebase/firestore with all functions used by the hook
vi.mock('firebase/firestore', () => {
  const getDocs = vi.fn()
  const collection = vi.fn()
  const query = vi.fn()
  const where = vi.fn()
  const doc = vi.fn()
  const updateDoc = vi.fn()
  const deleteDoc = vi.fn()
  const addDoc = vi.fn()
  const serverTimestamp = vi.fn(() => new Date())
  const arrayUnion = vi.fn((...args) => args)
  return { getDocs, collection, query, where, doc, updateDoc, deleteDoc, addDoc, serverTimestamp, arrayUnion }
})

vi.mock('../lib/firebase', () => ({
  db: {},
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'u1' }, orgSlug: 'acme' }),
}))

import { useShipments } from '../hooks/useShipments'
import { getDocs, updateDoc } from 'firebase/firestore'

describe('useShipments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fetches shipments on mount and sorts by date descending', async () => {
    const fakeDocs = [
      { id: 'a', data: () => ({ date: '2026-06-01', patientName: 'X' }) },
      { id: 'b', data: () => ({ date: '2026-06-10', patientName: 'Y' }) },
    ]
    getDocs.mockResolvedValue({ docs: fakeDocs })

    const { result } = renderHook(() => useShipments('acme'))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(getDocs).toHaveBeenCalledTimes(1)
    // onSnapshot is not imported, so it cannot be called; we assert it's not in the mock
    expect(result.current.shipments).toHaveLength(2)
    expect(result.current.shipments[0].id).toBe('b')
    expect(result.current.shipments[1].id).toBe('a')
  })

  it('refresh triggers another getDocs call', async () => {
    const fakeDocs = [
      { id: 'a', data: () => ({ date: '2026-06-01', patientName: 'X' }) },
      { id: 'b', data: () => ({ date: '2026-06-10', patientName: 'Y' }) },
    ]
    getDocs.mockResolvedValue({ docs: fakeDocs })

    const { result } = renderHook(() => useShipments('acme'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(getDocs).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.refresh()
    })

    expect(getDocs).toHaveBeenCalledTimes(2)
  })

  it('updateShipment calls updateDoc then getDocs', async () => {
    const fakeDocs = [
      { id: 'a', data: () => ({ date: '2026-06-01', patientName: 'X' }) },
      { id: 'b', data: () => ({ date: '2026-06-10', patientName: 'Y' }) },
    ]
    getDocs.mockResolvedValue({ docs: fakeDocs })
    updateDoc.mockResolvedValue()

    const { result } = renderHook(() => useShipments('acme'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    getDocs.mockClear()

    await act(async () => {
      await result.current.updateShipment('a', { status: 'delivered' })
    })

    expect(updateDoc).toHaveBeenCalledTimes(1)
    expect(getDocs).toHaveBeenCalledTimes(1)
  })

  it('sets error when getDocs rejects', async () => {
    getDocs.mockRejectedValueOnce(new Error('Network error'))

    const { result } = renderHook(() => useShipments('acme'))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBe('Network error')
    expect(result.current.loading).toBe(false)
  })
})
