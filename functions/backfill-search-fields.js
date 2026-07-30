import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const MAX_SLUG_LEN = 128
const DEFAULT_CHUNK = 500
const MAX_CHUNK = 500

/**
 * Backfills the `patientNameLower` field on every shipment in an
 * organization that predates server-side cursor pagination.
 *
 * Firestore prefix search is a case-sensitive range query, so each
 * shipment carries a normalized `patientNameLower`.  Until every
 * document has the field, paginated queries must not filter or order
 * on it — the completion flag signals when it is safe to do so.
 *
 * Chunked and resumable: returns a cursor so the client can drive the
 * job to completion.  Idempotent by field presence — a document whose
 * `patientNameLower` already exists (including an empty string) is
 * never rewritten.
 */
export const backfillSearchFields = onCall(async (request) => {
  // ── auth ────────────────────────────────────────────────────────
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login required')
  }

  // ── input validation ────────────────────────────────────────────
  const { slug, cursor, limit } = request.data || {}

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

  let chunkSize = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_CHUNK
  if (chunkSize > MAX_CHUNK) chunkSize = MAX_CHUNK

  // ── admin check ─────────────────────────────────────────────────
  const firestore = getFirestore()
  const memberSnap = await firestore
    .doc(`organizations/${orgSlug}/members/${request.auth.uid}`)
    .get()

  if (!memberSnap.exists || memberSnap.data().role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin access required')
  }

  // ── backfill ────────────────────────────────────────────────────
  try {
    let query = firestore
      .collection(`organizations/${orgSlug}/shipments`)
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

    const batch = firestore.batch()
    let updated = 0

    snapshot.forEach((doc) => {
      if (doc.data().patientNameLower === undefined) {
        const raw = doc.data().patientName
        const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
        batch.update(doc.ref, { patientNameLower: value })
        updated++
      }
    })

    if (updated > 0) {
      await batch.commit()
    }

    const results = snapshot.docs
    const processed = results.length
    const done = processed < chunkSize
    const lastDoc =
      results.length > 0 ? results[results.length - 1].id : null

    if (done) {
      await firestore.doc(`organizations/${orgSlug}`).update({
        searchBackfillComplete: true,
        searchBackfillCompletedAt: FieldValue.serverTimestamp(),
      })
    }

    return { processed, updated, done, cursor: lastDoc }
  } catch (err) {
    console.error('backfillSearchFields failed', err)
    throw new HttpsError('internal', 'Backfill failed')
  }
})
