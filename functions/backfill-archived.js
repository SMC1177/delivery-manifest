import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { getFirestore } from 'firebase-admin/firestore'

const MAX_SLUG_LEN = 128
const DEFAULT_CHUNK = 500
const MAX_CHUNK = 500

/**
 * Backfills the `archived` field on every shipment in an organization
 * that predates the archive feature.
 *
 * Must run before any query filters on `archived`, because Firestore
 * excludes documents that lack the field from `where('archived','==',false)`.
 *
 * Chunked and resumable: returns a cursor so the client can drive the
 * job to completion.  Idempotent — never clobbers an existing field.
 */
export const backfillArchivedFlag = onCall(async (request) => {
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
      if (doc.data().archived === undefined) {
        batch.update(doc.ref, { archived: false })
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

    return { processed, updated, done, cursor: lastDoc }
  } catch (err) {
    console.error('backfillArchivedFlag failed', err)
    throw new HttpsError('internal', 'Backfill failed')
  }
})
