import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// ── Mock firebase/functions ──────────────────────────────────────
vi.mock('firebase/functions', () => {
  const httpsCallable = vi.fn()
  const getFunctions = vi.fn(() => ({}))
  return { httpsCallable, getFunctions }
})

import { useArchiveActions } from '../hooks/useArchiveActions'
import { httpsCallable } from 'firebase/functions'

// ───────────────────────────────────────────────────────────────────
// BACKFILL SEARCH FIELDS — adversarial breaker tests
// ───────────────────────────────────────────────────────────────────
describe('backfillSearchFields resumable loop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── 1. RESUMPTION ──────────────────────────────────────────────
  it('passes the returned cursor to the next invocation (resumption)', async () => {
    const callableFn = vi.fn()
      .mockResolvedValueOnce({
        data: { processed: 100, updated: 100, done: false, cursor: 'cursor-a' },
      })
      .mockResolvedValueOnce({
        data: { processed: 50, updated: 50, done: true, cursor: 'cursor-b' },
      })
    httpsCallable.mockReturnValue(callableFn)

    const { result } = renderHook(() => useArchiveActions('acme'))

    await act(async () => {
      await result.current.backfillSearchFields()
    })

    // The second invocation must carry cursor-a from the first response.
    expect(callableFn).toHaveBeenCalledTimes(2)
    expect(callableFn.mock.calls[1][0]).toMatchObject({ cursor: 'cursor-a' })
    expect(result.current.error).toBeNull()
    expect(result.current.busy).toBe(false)
  })

  // ── 2. TERMINATION ─────────────────────────────────────────────
  it('stops as soon as the server reports done and does not make a further call', async () => {
    const callableFn = vi.fn().mockResolvedValue({
      data: { processed: 42, updated: 42, done: true },
    })
    httpsCallable.mockReturnValue(callableFn)

    const { result } = renderHook(() => useArchiveActions('acme'))

    await act(async () => {
      await result.current.backfillSearchFields()
    })

    expect(callableFn).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBeNull()
    expect(result.current.busy).toBe(false)
  })

  // ── 3. STALE CURSOR → ABORT (the critical runaway guard) ──────
  it('aborts with an error when the server returns the same cursor repeatedly', async () => {
    const callableFn = vi.fn().mockResolvedValue({
      data: { processed: 500, updated: 500, done: false, cursor: 'stuck-cursor' },
    })
    httpsCallable.mockReturnValue(callableFn)

    const { result } = renderHook(() => useArchiveActions('acme'))

    await act(async () => {
      await result.current.backfillSearchFields()
    })

    // First iteration: cursor advances null → 'stuck-cursor' (ok).
    // Second iteration: cursor 'stuck-cursor' → 'stuck-cursor' (stale).
    // Guard fires → exactly 2 calls, then error.
    expect(callableFn).toHaveBeenCalledTimes(2)
    expect(result.current.error).toContain('cursor did not advance')
    expect(result.current.busy).toBe(false)
  })

  // ── 4. ITERATION CAP ──────────────────────────────────────────
  it('stops at the iteration cap when the server never reports done', async () => {
    let callCount = 0
    const callableFn = vi.fn().mockImplementation(() => {
      callCount++
      return Promise.resolve({
        data: {
          processed: 1,
          updated: 0,
          done: false,
          cursor: `cursor-${callCount}`,
        },
      })
    })
    httpsCallable.mockReturnValue(callableFn)

    const { result } = renderHook(() => useArchiveActions('acme'))

    await act(async () => {
      await result.current.backfillSearchFields()
    })

    // MAX_ITERATIONS = 2000.  The guard is iterations > 2000, so the
    // callable is invoked 2000 times before the 2001st iteration
    // throws *before* making a further call.
    expect(callableFn).toHaveBeenCalledTimes(2000)
    expect(result.current.error).toContain('exceeded 2000 iterations')
    expect(result.current.busy).toBe(false)
  }, 15000)

  // ── 5. REJECTION ──────────────────────────────────────────────
  it('surfaces errors from a rejecting callable and clears the busy flag', async () => {
    const callableFn = vi.fn().mockRejectedValue(new Error('Functions unavailable'))
    httpsCallable.mockReturnValue(callableFn)

    const { result } = renderHook(() => useArchiveActions('acme'))

    await act(async () => {
      await result.current.backfillSearchFields()
    })

    expect(result.current.error).toBe('Functions unavailable')
    expect(result.current.busy).toBe(false)
  })

  // ── 6. ACCUMULATION ───────────────────────────────────────────
  it('accumulates progress totals across multiple chunks, not just the last', async () => {
    const callableFn = vi.fn()
      .mockResolvedValueOnce({
        data: { processed: 500, updated: 300, done: false, cursor: 'c1' },
      })
      .mockResolvedValueOnce({
        data: { processed: 200, updated: 50, done: true, cursor: 'c2' },
      })
    httpsCallable.mockReturnValue(callableFn)

    const { result } = renderHook(() => useArchiveActions('acme'))

    await act(async () => {
      await result.current.backfillSearchFields()
    })

    // The progress must be the SUM, not just the final chunk's values.
    expect(result.current.progress).toEqual({ processed: 700, changed: 350 })
    expect(result.current.error).toBeNull()
    expect(result.current.busy).toBe(false)
  })
})
