// v2/src/hooks/useImports.js
// Hook for listing recent CSV import runs and driving the undoImport
// callable to completion across chunks.  Follows the resumable-callable
// pattern established in useArchiveActions.

import { useState, useRef, useCallback, useEffect } from 'react'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { collection, query, orderBy, getDocs, limit } from 'firebase/firestore'
import { db } from '../lib/firebase'

// 2000 × 500 = 1 000 000 records — this is a RUNWAY BACKSTOP only.
// The PRIMARY infinite-loop guard is the non-advancing-cursor detection
// inside the loop; do NOT tighten this number without understanding that.
const MAX_ITERATIONS = 2000
const CHUNK_SIZE = 500

// A review list, not an archive — 25 is enough to show recent activity
// without pulling an unbounded number of documents.
const RECENT_IMPORTS_CAP = 25

export function useImports(orgSlug) {
  // ── list state ──────────────────────────────────────────────────
  const [imports, setImports] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // ── action state ────────────────────────────────────────────────
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState({ processed: 0, deleted: 0 })

  // ── unmount guard ──────────────────────────────────────────────
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // ── list fetch ──────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    if (!orgSlug) {
      setImports([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const colRef = collection(db, 'organizations', orgSlug, 'imports')
      const q = query(
        colRef,
        orderBy('importedAt', 'desc'),
        limit(RECENT_IMPORTS_CAP),
      )
      const snap = await getDocs(q)
      setImports(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    } catch (err) {
      console.error('Imports fetch error:', err)
      setError(err.message || 'Failed to load imports')
    } finally {
      setLoading(false)
    }
  }, [orgSlug])

  useEffect(() => {
    refresh()
  }, [refresh])

  // ── dry-run count (single call, no loop) ────────────────────────
  const countUndoTargets = useCallback(
    async (importId) => {
      const callable = httpsCallable(getFunctions(), 'undoImport')
      const payload = { slug: orgSlug, importId, dryRun: true, limit: CHUNK_SIZE }
      const result = await callable(payload)
      return result.data.deleted
    },
    [orgSlug],
  )

  // ── undo (looping) ──────────────────────────────────────────────
  const undoImport = useCallback(
    async ({ importId, confirmCount }) => {
      setBusy(true)
      setProgress({ processed: 0, deleted: 0 })
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
              `Undo import exceeded ${MAX_ITERATIONS} iterations — aborting to prevent infinite loop`,
            )
          }

          const callable = httpsCallable(getFunctions(), 'undoImport')
          const payload = {
            slug: orgSlug,
            importId,
            cursor,
            limit: CHUNK_SIZE,
            confirmCount,
          }

          const result = await callable(payload)
          const { processed, deleted, done, cursor: nextCursor } = result.data

          totalProcessed += processed
          totalDeleted += deleted

          if (!mountedRef.current) return

          setProgress({ processed: totalProcessed, deleted: totalDeleted })

          if (done) break

          if (!nextCursor || nextCursor === cursor) {
            throw new Error(
              'Undo import cursor did not advance — aborting to prevent infinite loop',
            )
          }

          cursor = nextCursor
        }
      } catch (err) {
        if (!mountedRef.current) return
        setError(err.message || 'Undo import failed')
      } finally {
        if (mountedRef.current) {
          setBusy(false)
        }
      }
    },
    [orgSlug],
  )

  return {
    imports,
    loading,
    error,
    refresh,
    busy,
    progress,
    undoImport,
    countUndoTargets,
  }
}
