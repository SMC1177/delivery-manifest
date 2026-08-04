// functions/upload-org-logo.js
// Server-side org logo upload written through the Admin SDK.
//
// WHY THIS EXISTS: the previous implementation uploaded from the BROWSER
// directly to Cloud Storage and failed through three successive gates (bucket
// never provisioned, no Storage rules, then ungranted cross-service Firestore
// permission) and STILL returned 403. Writing via the Admin SDK bypasses
// Storage rules completely, which removes the cross-service firestore lookup,
// the contentType rule condition and the permission grant from the critical
// path in one move.
//
// The download token is embedded in object metadata and the URL is built
// here, so the client keeps retrieving the logo exactly as it did with the
// Firebase client SDK's getDownloadURL().
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { randomUUID } from 'node:crypto'

const MAX_SLUG_LEN = 128 // same limit every other org callable in this project uses
const MAX_IMAGE_BYTES = 2 * 1024 * 1024

// Allowed content types -> file extension. The object path is derived from
// THIS map only, never from a client-supplied filename.
//
// svg+xml is kept because the existing client already accepts SVG logos and
// renders logoUrl only inside an <img> tag, where browsers disable script
// execution; the only script-execution risk would be direct navigation to the
// URL, which the app never does.
const CONTENT_TYPE_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

function assertValidSlug(slug) {
  if (typeof slug !== 'string' || slug.trim() === '') {
    throw new HttpsError('invalid-argument', 'Organization slug is required')
  }
  const trimmed = slug.trim()
  if (trimmed.includes('/')) {
    throw new HttpsError('invalid-argument', 'Invalid organization slug')
  }
  if (trimmed.length > MAX_SLUG_LEN) {
    throw new HttpsError('invalid-argument', 'Organization slug is too long')
  }
  return trimmed
}

export const uploadOrgLogo = onCall(async (request) => {
  const data = request.data ?? {}

  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login required')
  }
  const uid = request.auth.uid

  const orgSlug = assertValidSlug(data.slug)

  // contentType must be one of the allow-listed image types.
  const contentType = data.contentType
  const ext = CONTENT_TYPE_EXT[contentType]
  if (!ext) {
    throw new HttpsError('invalid-argument', 'Unsupported image type')
  }

  // dataBase64: decode FIRST, then enforce the 2 MB cap on the DECODED
  // bytes. base64 inflates by roughly a third, so a size check on the
  // encoded string would let a ~2.6 MB file through. Malformed payloads are
  // rejected cleanly instead of being allowed to throw.
  const raw = typeof data.dataBase64 === 'string' ? data.dataBase64.trim() : ''
  const dataUrlMatch = raw.match(/^data:[^;,]+;base64,(.*)$/s)
  const base64 = (dataUrlMatch ? dataUrlMatch[1] : raw).replace(/\s+/g, '')
  if (base64 === '' || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new HttpsError('invalid-argument', 'Invalid image data')
  }
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0) {
    throw new HttpsError('invalid-argument', 'Invalid image data')
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new HttpsError('invalid-argument', 'Image is too large (max 2MB)')
  }

  const firestore = getFirestore()

  // AUTHORIZATION: org admin OR platform admin. The currently deployed
  // Storage rules honour only the org-admin path, which locks out a platform
  // admin supporting an org they are not enrolled in — do not reproduce that
  // limitation here.
  const memberSnap = await firestore.doc(`organizations/${orgSlug}/members/${uid}`).get()
  const isOrgAdmin = memberSnap.exists && memberSnap.data().role === 'admin'

  if (!isOrgAdmin) {
    // Same platform-admin predicate functions/lib/admin-guard.js performs.
    const profileSnap = await firestore.doc(`userProfiles/${uid}`).get()
    const isPlatformAdmin = profileSnap.exists && profileSnap.data().platformAdmin === true
    if (!isPlatformAdmin) {
      throw new HttpsError('permission-denied', 'Admin access required')
    }
  }

  // Object path derived from the validated contentType only — the caller
  // cannot influence where the object lands.
  const objectPath = `organizations/${orgSlug}/logo.${ext}`
  const downloadToken = randomUUID()

  try {
    const bucket = getStorage().bucket()
    await bucket.file(objectPath).save(buffer, {
      contentType,
      metadata: {
        metadata: {
          // firebaseStorageDownloadTokens is what the Firebase client SDK's
          // getDownloadURL() reads, so the existing UI keeps working
          // unchanged.
          firebaseStorageDownloadTokens: downloadToken,
        },
      },
    })

    const url =
      `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
      `${encodeURIComponent(objectPath)}?alt=media&token=${downloadToken}`

    // Audit entry through the same org audit-log path the other callables use
    // (e.g. sms-save-creds.js). Records the acting uid and the slug — never
    // the image bytes.
    await firestore.collection(`organizations/${orgSlug}/auditLog`).add({
      action: 'org.logo_updated',
      targetId: `logo.${ext}`,
      details: { contentType, orgSlug, logoUrl: url },
      userId: uid,
      timestamp: FieldValue.serverTimestamp(),
    })

    return { url }
  } catch (err) {
    console.error('uploadOrgLogo failed', err)
    throw new HttpsError('internal', `Logo upload failed: ${err.message || err}`)
  }
})
