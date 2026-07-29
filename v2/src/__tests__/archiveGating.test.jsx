import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

// ── Mock firebase/firestore ──
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

// ── Mock firebase/functions ──
vi.mock('firebase/functions', () => {
  const httpsCallable = vi.fn()
  const getFunctions = vi.fn(() => ({}))
  return { httpsCallable, getFunctions }
})

vi.mock('../lib/firebase', () => ({
  db: {},
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'u1' }, orgSlug: 'acme' }),
}))

import { useShipments } from '../hooks/useShipments'
import { useArchiveActions } from '../hooks/useArchiveActions'
import { getDocs, where } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'

const fakeDocs = [
  { id: 'a', data: () => ({ date: '2026-06-01', patientName: 'X' }) },
  { id: 'b', data: () => ({ date: '2026-06-10', patientName: 'Y' }) },
]

// ───────────────────────────────────────────────────────────────────
// ARCHIVE GATING — the query-constraint seam
// ───────────────────────────────────────────────────────────────────
describe('archive gating: useShipments query constraints', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDocs.mockResolvedValue({ docs: fakeDocs })
  })

  it('NO options → issues query with NO archived constraint (existing callers untouched)', async () => {
    const { result } = renderHook(() => useShipments('acme'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const archivedCalls = where.mock.calls.filter((c) => c[0] === 'archived')
    expect(archivedCalls).toHaveLength(0)
    expect(result.current.shipments).toHaveLength(2)
  })

  it('{ archived: false, backfillComplete: false } → NO archived constraint (un-backfilled org guard)', async () => {
    const { result } = renderHook(() =>
      useShipments('acme', { archived: false, backfillComplete: false }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    const archivedCalls = where.mock.calls.filter((c) => c[0] === 'archived')
    expect(archivedCalls).toHaveLength(0)
  })

  it('{ archived: false, backfillComplete: true } → constrains on archived == false', async () => {
    const { result } = renderHook(() =>
      useShipments('acme', { archived: false, backfillComplete: true }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(where).toHaveBeenCalledWith('archived', '==', false)
  })

  it('{ archived: true } → constrains on archived == true regardless of backfillComplete', async () => {
    const { result } = renderHook(() =>
      useShipments('acme', { archived: true }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(where).toHaveBeenCalledWith('archived', '==', true)
  })

  it('{ archived: true, backfillComplete: false } → still constrains on archived == true', async () => {
    const { result } = renderHook(() =>
      useShipments('acme', { archived: true, backfillComplete: false }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(where).toHaveBeenCalledWith('archived', '==', true)
  })

  it('backfillComplete: undefined → does NOT enable filtering (truthiness trap)', async () => {
    const { result } = renderHook(() =>
      useShipments('acme', { archived: false, backfillComplete: undefined }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    const archivedCalls = where.mock.calls.filter((c) => c[0] === 'archived')
    expect(archivedCalls).toHaveLength(0)
  })
})

// ───────────────────────────────────────────────────────────────────
// USE ARCHIVE ACTIONS — resumable loop invariants
// ───────────────────────────────────────────────────────────────────
describe('useArchiveActions resumable loop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loop: calls callable repeatedly until done === true, accumulating totals', async () => {
    const callableFn = vi.fn()
      .mockResolvedValueOnce({ data: { processed: 500, changed: 500, done: false, cursor: 'cursor-1' } })
      .mockResolvedValueOnce({ data: { processed: 500, changed: 500, done: false, cursor: 'cursor-2' } })
      .mockResolvedValueOnce({ data: { processed: 200, changed: 200, done: true, cursor: null } })
    httpsCallable.mockReturnValue(callableFn)

    const { result } = renderHook(() => useArchiveActions('acme'))

    await act(async () => {
      await result.current.archiveShipments({ mode: 'all' })
    })

    expect(callableFn).toHaveBeenCalledTimes(3)
    expect(result.current.error).toBeNull()
    expect(result.current.progress).toEqual({ processed: 1200, changed: 1200 })
    expect(result.current.busy).toBe(false)
  })

  it('non-advancing cursor → aborts with error instead of looping forever', async () => {
    const callableFn = vi.fn().mockResolvedValue({
      data: { processed: 500, changed: 500, done: false, cursor: 'stuck-cursor' },
    })
    httpsCallable.mockReturnValue(callableFn)

    const { result } = renderHook(() => useArchiveActions('acme'))

    await act(async () => {
      await result.current.archiveShipments({ mode: 'all' })
    })

    // First iteration: cursor null → 'stuck-cursor' (advances).
    // Second iteration: cursor 'stuck-cursor' → 'stuck-cursor' (stuck).
    // Guard fires on the second return, so callableFn is called exactly twice.
    expect(callableFn).toHaveBeenCalledTimes(2)
    expect(result.current.error).toContain('cursor did not advance')
    expect(result.current.busy).toBe(false)
  })
})
