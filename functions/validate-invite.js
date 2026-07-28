// functions/validate-invite.js
// Public (unauthenticated) callable for pre-auth invite validation.
// Returns a minimal safe verdict so a signed-out user can see the org
// name and role before creating an account — without exposing internal
// invite data or leaking which organizations exist.
// Invoked by the /:slug/join page before the user has an account.

import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { getFirestore } from 'firebase-admin/firestore'

export const validateInvite = onCall(async (request) => {
  const { slug, code } = request.data || {}

  // Validate slug — must be non-empty string, trimmed, length-capped.
  if (!slug || typeof slug !== 'string') {
    throw new HttpsError('invalid-argument', 'slug must be a non-empty string')
  }
  const trimmedSlug = slug.trim()
  if (!trimmedSlug || trimmedSlug.length > 128 || trimmedSlug.includes('/')) {
    throw new HttpsError('invalid-argument', 'slug must be a non-empty string (max 128 chars) without "/"')
  }

  // Validate code — must be non-empty string, trimmed, length-capped.
  if (!code || typeof code !== 'string') {
    throw new HttpsError('invalid-argument', 'code must be a non-empty string')
  }
  const trimmedCode = code.trim()
  if (!trimmedCode || trimmedCode.length > 64) {
    throw new HttpsError('invalid-argument', 'code must be a non-empty string (max 64 chars)')
  }

  try {
    const firestore = getFirestore()

    // Look up org — fall through to generic 'invalid' if it doesn't exist,
    // so an attacker cannot distinguish a real org from a nonexistent one.
    const orgSnap = await firestore.doc(`organizations/${trimmedSlug}`).get()
    if (!orgSnap.exists) {
      return { valid: false, reason: 'invalid' }
    }

    const orgData = orgSnap.data()
    const orgName = orgData?.name || trimmedSlug

    // Query invite by code — limit 1 since codes should be unique per org.
    const invitesSnap = await firestore
      .collection(`organizations/${trimmedSlug}/invites`)
      .where('code', '==', trimmedCode)
      .limit(1)
      .get()

    if (invitesSnap.empty) {
      return { valid: false, reason: 'invalid' }
    }

    const inviteDoc = invitesSnap.docs[0]
    const inviteData = inviteDoc.data()
    const inviteId = inviteDoc.id
    const role = inviteData.role || 'staff'

    // Check expiration — handle Firestore Timestamp, Date, or missing.
    if (inviteData.expiresAt != null) {
      const expiresAt =
        typeof inviteData.expiresAt.toDate === 'function'
          ? inviteData.expiresAt.toDate()
          : new Date(inviteData.expiresAt)
      if (expiresAt < new Date()) {
        return { valid: false, reason: 'expired' }
      }
    }

    // Check usage limit — maxUses of 0 means unlimited.
    const maxUses = inviteData.maxUses || 0
    const usedCount = inviteData.usedCount || 0
    if (maxUses > 0 && usedCount >= maxUses) {
      return { valid: false, reason: 'exhausted' }
    }

    return { valid: true, orgName, role, inviteId }
  } catch (err) {
    // Re-throw HttpsError as-is so input validation errors surface properly.
    if (err instanceof HttpsError) throw err
    // Log the real error but return a generic message to the caller.
    console.error('validateInvite internal error:', err)
    throw new HttpsError('internal', 'Unable to validate invite')
  }
})
