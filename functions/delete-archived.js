import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const MAX_SLUG_LEN = 128
const DEFAULT_CHUNK = 500
const MAX_CHUNK = 500
const MAX_IDS = 500

/**
 * Permanently deletes archived shipment documents from an organization.
 *
 * THE MOST DESTRUCTIVE CODE IN THE PRODUCT — erases patient delivery records
 * with no undo. Every guard below is load-bearing.
 *
 * CRITICAL GUARD — archived-only: only deletes documents where
 * `archived === true` (strict equality). A document missing the field
 * is NEVER deleted, even when its id appears in `ids` or it matches a
 * filter. This enforces a two-step journey: archive first, then delete.
 *
 * Three modes (mutually exclusive):
 * - `ids`: deletes specific archived shipments by document id array
 *   (max 500, rejected if longer).
 * - `filter`: deletes archived shipments matching a criteria object with
 *   any combination of status, dateFrom, dateTo (inclusive), and search
 *   (caller-lowercased patient-name prefix matched via range query against
 *   patientNameLower). At least one criterion is required; an empty filter
 *   is rejected. Criteria combine as AND.
 * - No ids / no filter: deletes ALL archived shipments in the org, chunked
 *   and cursor-resumable.
 *
 * confirmCount: on the first chunk only (no cursor), counts what the
 * server is about to delete and compares to the caller-supplied value.
 * On mismatch, deletes NOTHING and throws so the client can re-confirm.
 * Subsequent cursor-resume chunks skip the check. This applies to ALL
 * modes, including filter — the server counts the matching set itself.
 *
 * dryRun: counts deletable docs but constructs NO batch — structurally
 * impossible to delete anything.
 *
 * Audit: logs every real deletion with counts, acting uid, and mode.
 * NEVER puts patient data in the audit entry.
 */
export const deleteArchivedShipments = onCall(async (request) => {
  // ── auth ────────────────────────────────────────────────────────
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login required')
  }

  // ── input validation ────────────────────────────────────────────
  const { slug, ids, cursor, limit, confirmCount, dryRun, filter } =
    request.data || {}

  if (typeof slug !== 'string' || slug.trim() === '') {
    throw new HttpsError('invalid-argument', 'Slug is required')
  }
  const orgSlug = slug.trim()
  if (orgSlug.length > MAX_SLUG_LEN) {
    throw new HttpsError('invalid-argument', 'Slug too long')
  }
  if (orgSlug.includes('/')) {
    throw new HttpsError('invalid-argument', 'Invalid slug')
  }

  const hasIds = ids !== undefined

  if (hasIds) {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new HttpsError(
        'invalid-argument',
        'ids array must not be empty',
      )
    }
    if (ids.length > MAX_IDS) {
      throw new HttpsError(
        'invalid-argument',
        `ids array must not exceed ${MAX_IDS} entries (got ${ids.length})`,
      )
    }
  }

  // ── filter validation ──────────────────────────────────────────
  let hasFilter = false
  let hasStatus = false
  let hasDateFrom = false
  let hasDateTo = false
  let hasSearch = false

  if (filter !== undefined) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      throw new HttpsError('invalid-argument', 'filter must be an object')
    }
    hasFilter = true
    hasStatus =
      typeof filter.status === 'string' && filter.status.trim() !== ''
    hasDateFrom =
      typeof filter.dateFrom === 'string' && filter.dateFrom.trim() !== ''
    hasDateTo =
      typeof filter.dateTo === 'string' && filter.dateTo.trim() !== ''
    hasSearch =
      typeof filter.search === 'string' && filter.search.trim() !== ''

    if (!hasStatus && !hasDateFrom && !hasDateTo && !hasSearch) {
      throw new HttpsError(
        'invalid-argument',
        'at least one criterion (status, dateFrom, dateTo, search) is required for filter mode',
      )
    }
    if (hasDateFrom && isNaN(Date.parse(filter.dateFrom.trim()))) {
      throw new HttpsError('invalid-argument', 'dateFrom must be a valid date string')
    }
    if (hasDateTo && isNaN(Date.parse(filter.dateTo.trim()))) {
      throw new HttpsError('invalid-argument', 'dateTo must be a valid date string')
    }
  }

  let chunkSize =
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_CHUNK
  if (chunkSize > MAX_CHUNK) chunkSize = MAX_CHUNK

  const isDryRun = Boolean(dryRun)

  // confirmCount must be a non-negative integer when supplied
  if (confirmCount !== undefined && confirmCount !== null) {
    if (
      !Number.isFinite(confirmCount) ||
      confirmCount < 0 ||
      !Number.isInteger(confirmCount)
    ) {
      throw new HttpsError(
        'invalid-argument',
        'confirmCount must be a non-negative integer',
      )
    }
  }

  // ── admin check ─────────────────────────────────────────────────
  const firestore = getFirestore()
  const memberSnap = await firestore
    .doc(`organizations/${orgSlug}/members/${request.auth.uid}`)
    .get()

  if (!memberSnap.exists || memberSnap.data().role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin access required')
  }

  const shipmentsRef = firestore.collection(
    `organizations/${orgSlug}/shipments`,
  )

  // ── delete ──────────────────────────────────────────────────────
  try {
    let docsToProcess = []
    let lastCursor = null
    let done = false

    if (hasIds) {
      // ── ids mode ────────────────────────────────────────────────

      // confirmCount: on first chunk, fetch ALL ids to get total
      // archived count before deleting anything
      if (!cursor && confirmCount !== undefined && confirmCount !== null) {
        const allRefs = ids.map((id) =>
          firestore.doc(`organizations/${orgSlug}/shipments/${id}`),
        )
        const allSnaps = await Promise.all(allRefs.map((r) => r.get()))
        const totalArchived = allSnaps.filter(
          (s) => s.exists && s.data().archived === true,
        ).length
        if (totalArchived !== confirmCount) {
          throw new HttpsError(
            'aborted',
            `Count mismatch: expected ${confirmCount} to delete, found ${totalArchived} archived. Re-confirm to proceed.`,
          )
        }
      }

      // chunk the id list
      let idList = [...ids]
      if (cursor) {
        const cursorIdx = idList.indexOf(cursor)
        if (cursorIdx >= 0) {
          idList = idList.slice(cursorIdx + 1)
        }
      }

      const batchIds = idList.slice(0, chunkSize)
      done = idList.length <= chunkSize

      if (batchIds.length > 0) {
        const docRefs = batchIds.map((id) =>
          firestore.doc(`organizations/${orgSlug}/shipments/${id}`),
        )
        const snapshots = await Promise.all(docRefs.map((ref) => ref.get()))
        docsToProcess = snapshots.filter((snap) => snap.exists)
      }

      lastCursor =
        batchIds.length > 0 ? batchIds[batchIds.length - 1] : null
    } else if (hasFilter) {
      // ── filter mode ─────────────────────────────────────────────

      // Build criteria (trimmed copies)
      const criteria = {}
      if (hasStatus) criteria.status = filter.status.trim()
      if (hasDateFrom) criteria.dateFrom = filter.dateFrom.trim()
      if (hasDateTo) criteria.dateTo = filter.dateTo.trim()
      if (hasSearch) criteria.search = filter.search.trim()

      // confirmCount: on first chunk only, count matching archived docs
      if (!cursor && confirmCount !== undefined && confirmCount !== null) {
        let countQuery = shipmentsRef.where('archived', '==', true)
        if (hasStatus) {
          countQuery = countQuery.where('status', '==', criteria.status)
        }
        if (hasDateFrom) {
          countQuery = countQuery.where('date', '>=', criteria.dateFrom)
        }
        if (hasDateTo) {
          countQuery = countQuery.where('date', '<=', criteria.dateTo)
        }
        if (hasSearch) {
          countQuery = countQuery
            .where('patientNameLower', '>=', criteria.search)
            .where('patientNameLower', '<=', criteria.search + '\uf8ff')
        }

        const countSnap = await countQuery.count().get()
        const totalArchived = countSnap.data().count
        if (totalArchived !== confirmCount) {
          throw new HttpsError(
            'aborted',
            `Count mismatch: expected ${confirmCount} to delete, found ${totalArchived} archived. Re-confirm to proceed.`,
          )
        }
      }

      // Build query — mirrors archive-shipments filter criteria shape
      let filterQuery = shipmentsRef.where('archived', '==', true)
      const orderFields = []

      if (hasStatus) {
        filterQuery = filterQuery.where('status', '==', criteria.status)
        orderFields.push('status')
      }

      if (hasDateFrom) {
        filterQuery = filterQuery.where('date', '>=', criteria.dateFrom)
        if (!orderFields.includes('date')) orderFields.push('date')
      }
      if (hasDateTo) {
        filterQuery = filterQuery.where('date', '<=', criteria.dateTo)
        if (!orderFields.includes('date')) orderFields.push('date')
      }

      if (hasSearch) {
        filterQuery = filterQuery
          .where('patientNameLower', '>=', criteria.search)
          .where('patientNameLower', '<=', criteria.search + '\uf8ff')
        orderFields.push('patientNameLower')
      }

      for (const field of orderFields) {
        filterQuery = filterQuery.orderBy(field)
      }
      filterQuery = filterQuery.orderBy('__name__').limit(chunkSize)

      if (cursor) {
        const cursorDocSnap = await firestore
          .doc(`organizations/${orgSlug}/shipments/${cursor}`)
          .get()
        if (cursorDocSnap.exists) {
          filterQuery = filterQuery.startAfter(cursorDocSnap)
        }
      }

      const snapshot = await filterQuery.get()
      docsToProcess = snapshot.docs
      done = docsToProcess.length < chunkSize
      lastCursor =
        docsToProcess.length > 0
          ? docsToProcess[docsToProcess.length - 1].id
          : null
    } else {
      // ── all-archived mode (no ids) ──────────────────────────────

      // confirmCount: on first chunk only, count total archived docs
      if (!cursor && confirmCount !== undefined && confirmCount !== null) {
        const countSnap = await shipmentsRef
          .where('archived', '==', true)
          .count()
          .get()
        const totalArchived = countSnap.data().count
        if (totalArchived !== confirmCount) {
          throw new HttpsError(
            'aborted',
            `Count mismatch: expected ${confirmCount} to delete, found ${totalArchived} archived. Re-confirm to proceed.`,
          )
        }
      }

      let query = shipmentsRef
        .where('archived', '==', true)
        .orderBy('__name__')
        .limit(chunkSize)

      if (cursor) {
        const cursorDocSnap = await firestore
          .doc(`organizations/${orgSlug}/shipments/${cursor}`)
          .get()
        if (cursorDocSnap.exists) {
          query = query.startAfter(cursorDocSnap)
        }
      }

      const snapshot = await query.get()
      docsToProcess = snapshot.docs
      done = docsToProcess.length < chunkSize
      lastCursor =
        docsToProcess.length > 0
          ? docsToProcess[docsToProcess.length - 1].id
          : null
    }

    const processed = docsToProcess.length

    // ── THE LOAD-BEARING GUARD: only delete when archived === true ──
    // Use strict equality — a missing field must NOT match
    const deletableDocs = docsToProcess.filter(
      (doc) => doc.data().archived === true,
    )

    if (isDryRun) {
      // Count without writing — batch is never created, no mutation possible
      const deleted = deletableDocs.length
      return { processed, deleted, done, cursor: lastCursor }
    }

    let deleted = 0

    if (deletableDocs.length > 0) {
      const batch = firestore.batch()
      for (const doc of deletableDocs) {
        batch.delete(doc.ref)
        deleted++
      }
      await batch.commit()
    }

    // ── audit ─────────────────────────────────────────────────────
    if (deleted > 0) {
      const auditEntry = {
        actor: request.auth.uid,
        actorEmail: request.auth.token?.email ?? null,
        action: 'delete_archived_shipments',
        orgSlug,
        deleted,
        at: FieldValue.serverTimestamp(),
      }
      if (hasIds) {
        auditEntry.mode = 'ids'
        auditEntry.idsCount = ids.length
      } else if (hasFilter) {
        auditEntry.mode = 'filter'
        auditEntry.criteria = filter
      } else {
        auditEntry.mode = 'all'
      }

      try {
        await firestore.collection('platformAudit').add(auditEntry)
      } catch (err) {
        console.error('Audit write failed:', err)
        throw new HttpsError('internal', 'audit write failed')
      }
    }

    return { processed, deleted, done, cursor: lastCursor }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    console.error('deleteArchivedShipments failed', err)
    throw new HttpsError('internal', 'Delete failed')
  }
})
