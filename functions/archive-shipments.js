import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const MAX_SLUG_LEN = 128
const DEFAULT_CHUNK = 500
const MAX_CHUNK = 500
const MAX_IDS = 500

/**
 * Archives shipments in an organization.
 *
 * Three modes:
 * - 'cutoff': archives all shipments whose date is strictly before cutoffDate —
 *   uses `where('date', '<', cutoffDate)` so records dated exactly on the cutoff
 *   are NOT included. This is the safe default: the admin picks a boundary like
 *   "2024-01-01" intending everything OLDER than that, not including it.
 * - 'ids': archives specific shipments by document ID array (max 500).
 * - 'filter': archives shipments matching a criteria object with any combination
 *   of status, dateFrom, dateTo, and search (patient name prefix). At least one
 *   criterion is required. Criteria combine as AND.
 *
 * Supports dryRun for counting without writing — structurally impossible to
 * mutate anything when dryRun is true (batch is never created).
 * Chunked and resumable with cursor.
 * Idempotent — already-archived shipments keep their original archivedAt.
 */
export const archiveShipments = onCall(async (request) => {
  // ── auth ────────────────────────────────────────────────────────
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login required')
  }

  // ── input validation ────────────────────────────────────────────
  const {
    slug, mode, cutoffDate, ids, criteria, cursor, limit, dryRun,
  } = request.data || {}

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

  if (mode !== 'cutoff' && mode !== 'ids' && mode !== 'filter') {
    throw new HttpsError('invalid-argument', 'mode must be "cutoff", "ids", or "filter"')
  }

  if (mode === 'cutoff') {
    if (!cutoffDate || typeof cutoffDate !== 'string') {
      throw new HttpsError('invalid-argument', 'cutoffDate is required for cutoff mode')
    }
    if (isNaN(Date.parse(cutoffDate))) {
      throw new HttpsError('invalid-argument', 'cutoffDate must be a valid date string')
    }
  }

  if (mode === 'ids') {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new HttpsError('invalid-argument', 'ids array is required for ids mode')
    }
    if (ids.length > MAX_IDS) {
      throw new HttpsError(
        'invalid-argument',
        `ids array must not exceed ${MAX_IDS} entries (got ${ids.length})`,
      )
    }
  }

  if (mode === 'filter') {
    if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
      throw new HttpsError('invalid-argument', 'criteria object is required for filter mode')
    }
    const hasStatus = typeof criteria.status === 'string' && criteria.status.trim() !== ''
    const hasDateFrom = typeof criteria.dateFrom === 'string' && criteria.dateFrom.trim() !== ''
    const hasDateTo = typeof criteria.dateTo === 'string' && criteria.dateTo.trim() !== ''
    const hasSearch = typeof criteria.search === 'string' && criteria.search.trim() !== ''
    if (!hasStatus && !hasDateFrom && !hasDateTo && !hasSearch) {
      throw new HttpsError('invalid-argument', 'at least one criterion (status, dateFrom, dateTo, search) is required for filter mode')
    }
    if (hasDateFrom && isNaN(Date.parse(criteria.dateFrom.trim()))) {
      throw new HttpsError('invalid-argument', 'dateFrom must be a valid date string')
    }
    if (hasDateTo && isNaN(Date.parse(criteria.dateTo.trim()))) {
      throw new HttpsError('invalid-argument', 'dateTo must be a valid date string')
    }
  }

  let chunkSize =
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_CHUNK
  if (chunkSize > MAX_CHUNK) chunkSize = MAX_CHUNK

  const isDryRun = Boolean(dryRun)

  // ── admin check ─────────────────────────────────────────────────
  const firestore = getFirestore()
  const memberSnap = await firestore
    .doc(`organizations/${orgSlug}/members/${request.auth.uid}`)
    .get()

  if (!memberSnap.exists || memberSnap.data().role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin access required')
  }

  // ── archive ─────────────────────────────────────────────────────
  try {
    let docsToProcess = []
    let lastDocId = null
    let done = false

    if (mode === 'cutoff') {
      let query = firestore
        .collection(`organizations/${orgSlug}/shipments`)
        .where('date', '<', cutoffDate)
        .orderBy('date')
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
      lastDocId =
        docsToProcess.length > 0
          ? docsToProcess[docsToProcess.length - 1].id
          : null
    } else if (mode === 'filter') {
      let query = firestore
        .collection(`organizations/${orgSlug}/shipments`)

      const orderFields = []

      if (typeof criteria.status === 'string' && criteria.status.trim() !== '') {
        query = query.where('status', '==', criteria.status.trim())
        orderFields.push('status')
      }

      const dateFrom = typeof criteria.dateFrom === 'string' && criteria.dateFrom.trim() !== ''
        ? criteria.dateFrom.trim() : null
      const dateTo = typeof criteria.dateTo === 'string' && criteria.dateTo.trim() !== ''
        ? criteria.dateTo.trim() : null

      if (dateFrom) {
        query = query.where('date', '>=', dateFrom)
        if (!orderFields.includes('date')) orderFields.push('date')
      }
      if (dateTo) {
        query = query.where('date', '<=', dateTo)
        if (!orderFields.includes('date')) orderFields.push('date')
      }

      const search = typeof criteria.search === 'string' && criteria.search.trim() !== ''
        ? criteria.search.trim() : null

      if (search) {
        query = query.where('patientNameLower', '>=', search)
        query = query.where('patientNameLower', '<=', search + '\uf8ff')
        orderFields.push('patientNameLower')
      }

      for (const field of orderFields) {
        query = query.orderBy(field)
      }
      query = query.orderBy('__name__').limit(chunkSize)

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
      lastDocId =
        docsToProcess.length > 0
          ? docsToProcess[docsToProcess.length - 1].id
          : null
    } else {
      // ids mode — process the array in chunks
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

      lastDocId = batchIds.length > 0 ? batchIds[batchIds.length - 1] : null
    }

    const processed = docsToProcess.length
    let changed = 0

    if (isDryRun) {
      // Count without writing — batch is never created, no mutation possible
      for (const doc of docsToProcess) {
        if (doc.data().archived !== true) {
          changed++
        }
      }
    } else if (docsToProcess.length > 0) {
      const batch = firestore.batch()
      for (const doc of docsToProcess) {
        if (doc.data().archived === true) {
          continue // preserve original archivedAt
        }
        batch.update(doc.ref, {
          archived: true,
          archivedAt: FieldValue.serverTimestamp(),
          archivedBy: request.auth.uid,
        })
        changed++
      }

      if (changed > 0) {
        await batch.commit()
      }
    }

    // ── audit ─────────────────────────────────────────────────────
    if (!isDryRun && changed > 0) {
      const auditEntry = {
        actor: request.auth.uid,
        actorEmail: request.auth.token?.email ?? null,
        action: 'archive_shipments',
        orgSlug,
        mode,
        changed,
        at: FieldValue.serverTimestamp(),
      }
      if (mode === 'cutoff') {
        auditEntry.cutoffDate = cutoffDate
      } else if (mode === 'filter') {
        auditEntry.criteria = criteria
      } else {
        auditEntry.idsCount = ids.length
      }

      try {
        await firestore.collection('platformAudit').add(auditEntry)
      } catch (err) {
        console.error('Audit write failed:', err)
        throw new HttpsError('internal', 'audit write failed')
      }
    }

    return { processed, changed, done, cursor: lastDocId }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    console.error('archiveShipments failed', err)
    throw new HttpsError('internal', 'Archive failed')
  }
})

/**
 * Restores shipments from archive in an organization.
 *
 * Sets archived:false and removes archivedAt / archivedBy via
 * FieldValue.delete(), so a restored record is indistinguishable
 * from one that was never archived.
 *
 * Chunked and resumable with cursor. Skips records that are not archived.
 */
export const restoreShipments = onCall(async (request) => {
  // ── auth ────────────────────────────────────────────────────────
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login required')
  }

  // ── input validation ────────────────────────────────────────────
  const { slug, ids, cursor, limit } = request.data || {}

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

  if (!Array.isArray(ids) || ids.length === 0) {
    throw new HttpsError('invalid-argument', 'ids array is required')
  }
  if (ids.length > MAX_IDS) {
    throw new HttpsError(
      'invalid-argument',
      `ids array must not exceed ${MAX_IDS} entries (got ${ids.length})`,
    )
  }

  let chunkSize =
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_CHUNK
  if (chunkSize > MAX_CHUNK) chunkSize = MAX_CHUNK

  // ── admin check ─────────────────────────────────────────────────
  const firestore = getFirestore()
  const memberSnap = await firestore
    .doc(`organizations/${orgSlug}/members/${request.auth.uid}`)
    .get()

  if (!memberSnap.exists || memberSnap.data().role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin access required')
  }

  // ── restore ─────────────────────────────────────────────────────
  try {
    let idList = [...ids]
    if (cursor) {
      const cursorIdx = idList.indexOf(cursor)
      if (cursorIdx >= 0) {
        idList = idList.slice(cursorIdx + 1)
      }
    }

    const batchIds = idList.slice(0, chunkSize)
    const done = idList.length <= chunkSize

    let docsToProcess = []
    if (batchIds.length > 0) {
      const docRefs = batchIds.map((id) =>
        firestore.doc(`organizations/${orgSlug}/shipments/${id}`),
      )
      const snapshots = await Promise.all(docRefs.map((ref) => ref.get()))
      docsToProcess = snapshots.filter((snap) => snap.exists)
    }

    const processed = docsToProcess.length
    let changed = 0
    const lastDocId = batchIds.length > 0 ? batchIds[batchIds.length - 1] : null

    if (docsToProcess.length > 0) {
      const batch = firestore.batch()
      for (const doc of docsToProcess) {
        if (doc.data().archived !== true) {
          continue // not archived — nothing to restore
        }
        batch.update(doc.ref, {
          archived: false,
          archivedAt: FieldValue.delete(),
          archivedBy: FieldValue.delete(),
        })
        changed++
      }

      if (changed > 0) {
        await batch.commit()
      }
    }

    // ── audit ─────────────────────────────────────────────────────
    if (changed > 0) {
      try {
        await firestore.collection('platformAudit').add({
          actor: request.auth.uid,
          actorEmail: request.auth.token?.email ?? null,
          action: 'restore_shipments',
          orgSlug,
          idsCount: ids.length,
          changed,
          at: FieldValue.serverTimestamp(),
        })
      } catch (err) {
        console.error('Audit write failed:', err)
        throw new HttpsError('internal', 'audit write failed')
      }
    }

    return { processed, changed, done, cursor: lastDocId }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    console.error('restoreShipments failed', err)
    throw new HttpsError('internal', 'Restore failed')
  }
})
