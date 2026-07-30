import { useState, useRef, useCallback, useEffect } from 'react'
import { getFunctions, httpsCallable } from 'firebase/functions'

// 2000 × 500 = 1 000 000 records — this is a RUNWAY BACKSTOP only.
// The PRIMARY infinite-loop guard is the non-advancing-cursor detection
// inside each loop; do NOT tighten this number without understanding that.
const MAX_ITERATIONS = 2000
const CHUNK_SIZE = 500

/**
 * Hook that drives the four archive-related callables to completion
 * across potentially many 500-doc chunks.  Exposes running progress,
 * a busy flag, terminal errors, and a dry-run count helper.
 *
 * All four actions are idempotent server-side; this hook just loops
 * until `done` is true, with guards against infinite loops and
 * unmounted-component state updates.
 */
export function useArchiveActions(orgSlug) {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState({ processed: 0, changed: 0 })
  const [error, setError] = useState(null)

  // ── unmount guard ──────────────────────────────────────────────
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // ── helpers ────────────────────────────────────────────────────
  const clearError = useCallback(() => setError(null), [])

  // ── dry-run count (no loop, no write) ──────────────────────────
  const countArchiveTargets = useCallback(
    async ({ mode, cutoffDate, ids }) => {
      const callable = httpsCallable(getFunctions(), 'archiveShipments')
      const payload = { slug: orgSlug, mode, dryRun: true }
      if (mode === 'cutoff') payload.cutoffDate = cutoffDate
      if (mode === 'ids') payload.ids = ids
      const result = await callable(payload)
      return result.data.changed
    },
    [orgSlug],
  )

  // ── dry-run count for deletion (no loop, no write) ─────────────
  const countDeleteTargets = useCallback(
    async ({ ids }) => {
      const callable = httpsCallable(getFunctions(), 'deleteArchivedShipments')
      const payload = { slug: orgSlug, dryRun: true }
      if (ids) payload.ids = ids
      const result = await callable(payload)
      return result.data.deleted
    },
    [orgSlug],
  )

  // ── archive (looping) ──────────────────────────────────────────
  const archiveShipments = useCallback(
    async ({ mode, cutoffDate, ids }) => {
      setBusy(true)
      setProgress({ processed: 0, changed: 0 })
      setError(null)

      let cursor = null
      let totalProcessed = 0
      let totalChanged = 0
      let iterations = 0

      try {
        while (true) {
          iterations++
          if (iterations > MAX_ITERATIONS) {
            throw new Error(
              `Archive exceeded ${MAX_ITERATIONS} iterations — aborting to prevent infinite loop`,
            )
          }

          const callable = httpsCallable(getFunctions(), 'archiveShipments')
          const payload = { slug: orgSlug, mode, cursor, limit: CHUNK_SIZE }
          if (mode === 'cutoff') payload.cutoffDate = cutoffDate
          if (mode === 'ids') payload.ids = ids

          const result = await callable(payload)
          const { processed, changed, done, cursor: nextCursor } = result.data

          totalProcessed += processed
          totalChanged += changed

          if (!mountedRef.current) return

          setProgress({ processed: totalProcessed, changed: totalChanged })

          if (done) break

          // Loop hazard #1: non-advancing cursor
          if (!nextCursor || nextCursor === cursor) {
            throw new Error(
              'Archive cursor did not advance — aborting to prevent infinite loop',
            )
          }

          cursor = nextCursor
        }
      } catch (err) {
        if (!mountedRef.current) return
        setError(err.message || 'Archive failed')
      } finally {
        if (mountedRef.current) {
          setBusy(false)
        }
      }
    },
    [orgSlug],
  )

  // ── restore (looping) ──────────────────────────────────────────
  const restoreShipments = useCallback(
    async ({ ids }) => {
      setBusy(true)
      setProgress({ processed: 0, changed: 0 })
      setError(null)

      let cursor = null
      let totalProcessed = 0
      let totalChanged = 0
      let iterations = 0

      try {
        while (true) {
          iterations++
          if (iterations > MAX_ITERATIONS) {
            throw new Error(
              `Restore exceeded ${MAX_ITERATIONS} iterations — aborting to prevent infinite loop`,
            )
          }

          const callable = httpsCallable(getFunctions(), 'restoreShipments')
          const payload = { slug: orgSlug, ids, cursor, limit: CHUNK_SIZE }

          const result = await callable(payload)
          const { processed, changed, done, cursor: nextCursor } = result.data

          totalProcessed += processed
          totalChanged += changed

          if (!mountedRef.current) return

          setProgress({ processed: totalProcessed, changed: totalChanged })

          if (done) break

          if (!nextCursor || nextCursor === cursor) {
            throw new Error(
              'Restore cursor did not advance — aborting to prevent infinite loop',
            )
          }

          cursor = nextCursor
        }
      } catch (err) {
        if (!mountedRef.current) return
        setError(err.message || 'Restore failed')
      } finally {
        if (mountedRef.current) {
          setBusy(false)
        }
      }
    },
    [orgSlug],
  )

  // ── backfill (looping) ─────────────────────────────────────────
  const backfillArchivedFlag = useCallback(
    async () => {
      setBusy(true)
      setProgress({ processed: 0, changed: 0 })
      setError(null)

      let cursor = null
      let totalProcessed = 0
      let totalChanged = 0
      let iterations = 0

      try {
        while (true) {
          iterations++
          if (iterations > MAX_ITERATIONS) {
            throw new Error(
              `Backfill exceeded ${MAX_ITERATIONS} iterations — aborting to prevent infinite loop`,
            )
          }

          const callable = httpsCallable(getFunctions(), 'backfillArchivedFlag')
          const payload = { slug: orgSlug, cursor, limit: CHUNK_SIZE }

          const result = await callable(payload)
          const { processed, updated, done, cursor: nextCursor } = result.data

          totalProcessed += processed
          totalChanged += updated

          if (!mountedRef.current) return

          setProgress({ processed: totalProcessed, changed: totalChanged })

          if (done) break

          if (!nextCursor || nextCursor === cursor) {
            throw new Error(
              'Backfill cursor did not advance — aborting to prevent infinite loop',
            )
          }

          cursor = nextCursor
        }
      } catch (err) {
        if (!mountedRef.current) return
        setError(err.message || 'Backfill failed')
      } finally {
        if (mountedRef.current) {
          setBusy(false)
        }
      }
    },
    [orgSlug],
  )

  // ── search backfill (looping) ──────────────────────────────────
  const backfillSearchFields = useCallback(
    async () => {
      setBusy(true)
      setProgress({ processed: 0, changed: 0 })
      setError(null)

      let cursor = null
      let totalProcessed = 0
      let totalChanged = 0
      let iterations = 0

      try {
        while (true) {
          iterations++
          if (iterations > MAX_ITERATIONS) {
            throw new Error(
              `Search backfill exceeded ${MAX_ITERATIONS} iterations — aborting to prevent infinite loop`,
            )
          }

          const callable = httpsCallable(getFunctions(), 'backfillSearchFields')
          const payload = { slug: orgSlug, cursor, limit: CHUNK_SIZE }

          const result = await callable(payload)
          const { processed, updated, done, cursor: nextCursor } = result.data

          totalProcessed += processed
          totalChanged += updated

          if (!mountedRef.current) return

          setProgress({ processed: totalProcessed, changed: totalChanged })

          if (done) break

          if (!nextCursor || nextCursor === cursor) {
            throw new Error(
              'Search backfill cursor did not advance — aborting to prevent infinite loop',
            )
          }

          cursor = nextCursor
        }
      } catch (err) {
        if (!mountedRef.current) return
        setError(err.message || 'Search backfill failed')
      } finally {
        if (mountedRef.current) {
          setBusy(false)
        }
      }
    },
    [orgSlug],
  )

  // ── delete (looping) ───────────────────────────────────────────
  const deleteArchivedShipments = useCallback(
    async ({ ids, confirmCount }) => {
      setBusy(true)
      setProgress({ processed: 0, changed: 0 })
      setError(null)

      let cursor = null
      let totalProcessed = 0
      let totalDeleted = 0
      let iterations = 0

      try {
        while (true) {
          iterations++
          if (iterations > MAX_ITERATIONS) {
            throw new Error(
              `Delete exceeded ${MAX_ITERATIONS} iterations — aborting to prevent infinite loop`,
            )
          }

          const callable = httpsCallable(getFunctions(), 'deleteArchivedShipments')
          const payload = { slug: orgSlug, cursor, limit: CHUNK_SIZE, confirmCount }
          if (ids) payload.ids = ids

          const result = await callable(payload)
          const { processed, deleted, done, cursor: nextCursor } = result.data

          totalProcessed += processed
          totalDeleted += deleted

          if (!mountedRef.current) return

          setProgress({ processed: totalProcessed, changed: totalDeleted })

          if (done) break

          if (!nextCursor || nextCursor === cursor) {
            throw new Error(
              'Delete cursor did not advance — aborting to prevent infinite loop',
            )
          }

          cursor = nextCursor
        }
      } catch (err) {
        if (!mountedRef.current) return
        setError(err.message || 'Delete failed')
      } finally {
        if (mountedRef.current) {
          setBusy(false)
        }
      }
    },
    [orgSlug],
  )

  return {
    busy,
    progress,
    error,
    archiveShipments,
    restoreShipments,
    backfillArchivedFlag,
    backfillSearchFields,
    deleteArchivedShipments,
    countArchiveTargets,
    countDeleteTargets,
    clearError,
  }
}
