import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const MAX_SLUG_LEN = 128
const MAX_IMPORT_ID_LEN = 256
const DEFAULT_CHUNK = 500
const MAX_CHUNK = 500

/**
 * Undoes an import by permanently deleting all shipments bearing a given
 * importId, then removing the companion imports/{importId} record on the
 * final chunk.
 *
 * SCOPE GUARD — importId match only: only deletes shipments whose
 * `importId` field equals the supplied value exactly. A shipment from a
 * different import, or one with no importId at all — every record created
 * before this feature existed — is NEVER touched.
 *
 * Chunked at Firestore's 500-op limit, cursor-resumable. Returns
 * { processed, deleted, done, cursor }.
 *
 * confirmCount: on the first chunk only (no cursor), counts what the
 * server is about to delete and compares to the caller-supplied value.
 * On mismatch, deletes NOTHING and throws so the client can re-confirm.
 * Subsequent cursor-resume chunks skip the check.
 *
 * dryRun: counts deletable docs but constructs NO batch — structurally
 * impossible to delete anything.
 *
 * Companion record: the imports/{importId} document is deleted ONLY on
 * the final chunk, after shipments are gone. Removing it first would
 * orphan shipments with no visible import to undo; removing it last
 * makes an interrupted job simply resumable.
 *
 * Audit: logs every real deletion with counts, importId, and acting uid.
 * NEVER puts patient data in the audit entry.
 */
export const undoImport = onCall(async (request) => {
  // ── auth ────────────────────────────────────────────────────────
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login required')
  }

  // ── input validation ────────────────────────────────────────────
  const { slug, importId, cursor, limit, confirmCount, dryRun } =
    request.data || {}

  // slug
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

  // importId — must be a non-empty string with a sane max length;
  // a malformed or missing importId is rejected outright so we never
  // fall through to a query that would match a broad set of documents
  if (typeof importId !== 'string' || importId.trim() === '') {
    throw new HttpsError('invalid-argument', 'importId is required')
  }
  const trimmedImportId = importId.trim()
  if (trimmedImportId.length > MAX_IMPORT_ID_LEN) {
    throw new HttpsError('invalid-argument', 'importId too long')
  }

  // limit
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
    // confirmCount: on first chunk only, count docs matching importId
    if (!cursor && confirmCount !== undefined && confirmCount !== null) {
      const countSnap = await shipmentsRef
        .where('importId', '==', trimmedImportId)
        .count()
        .get()
      const totalMatching = countSnap.data().count
      if (totalMatching !== confirmCount) {
        throw new HttpsError(
          'aborted',
          `Count mismatch: expected ${confirmCount} to delete, found ${totalMatching} with importId. Re-confirm to proceed.`,
        )
      }
    }

    let query = shipmentsRef
      .where('importId', '==', trimmedImportId)
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
    const docsToProcess = snapshot.docs
    const processed = docsToProcess.length
    const done = docsToProcess.length < chunkSize
    const lastCursor =
      docsToProcess.length > 0
        ? docsToProcess[docsToProcess.length - 1].id
        : null

    if (isDryRun) {
      // Count without writing — batch is never created, no mutation possible
      const deleted = docsToProcess.length
      return { processed, deleted, done, cursor: lastCursor }
    }

    let deleted = 0

    if (docsToProcess.length > 0) {
      const batch = firestore.batch()
      for (const doc of docsToProcess) {
        batch.delete(doc.ref)
        deleted++
      }
      await batch.commit()
    }

    // ── companion record ──────────────────────────────────────────
    // Delete only on the final chunk, after shipments are gone.
    // Removing it first would orphan shipments with no visible import
    // to undo; removing it last makes an interrupted job resumable.
    if (done) {
      try {
        await firestore
          .doc(`organizations/${orgSlug}/imports/${trimmedImportId}`)
          .delete()
      } catch (err) {
        // Companion may already be missing — that is harmless;
        // log and continue so the call succeeds regardless.
        console.warn(
          `Companion import record not found or already deleted: organizations/${orgSlug}/imports/${trimmedImportId}`,
          err,
        )
      }
    }

    // ── audit ─────────────────────────────────────────────────────
    if (deleted > 0) {
      const auditEntry = {
        actor: request.auth.uid,
        actorEmail: request.auth.token?.email ?? null,
        action: 'undo_import',
        orgSlug,
        importId: trimmedImportId,
        deleted,
        at: FieldValue.serverTimestamp(),
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
    console.error('undoImport failed', err)
    throw new HttpsError('internal', 'Undo import failed')
  }
})
