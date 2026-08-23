import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

// This suite owns its own firebase/firestore mock, like its siblings.
vi.mock('firebase/firestore', () => {
  const getDocs = vi.fn()
  const collection = vi.fn()
  return { getDocs, collection }
})

vi.mock('../lib/firebase', () => ({
  db: {},
}))

import { useFacilities } from '../hooks/useFacilities'
import { getDocs } from 'firebase/firestore'

describe('useFacilities', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('premise guard: a successful read resolves facilities sorted by name', async () => {
    getDocs.mockResolvedValueOnce({
      docs: [
        { id: 'TRI-OOC', data: () => ({ name: 'TRI-OOC' }) },
        { id: 'TRI-HILT', data: () => ({ name: 'TRI-HILT' }) },
      ],
    })
    const { result } = renderHook(() => useFacilities('acme'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.facilities.map((f) => f.name)).toEqual(['TRI-HILT', 'TRI-OOC'])
    expect(result.current.error).toBeNull()
  })

  it('stores the error MESSAGE string when the read fails — an Error object rendered by FacilityPage is React #31', async () => {
    getDocs.mockRejectedValueOnce(new Error('Missing or insufficient permissions.'))
    const { result } = renderHook(() => useFacilities('acme'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('Missing or insufficient permissions.')
    expect(result.current.facilities).toEqual([])
  })
})
