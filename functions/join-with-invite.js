// functions/join-with-invite.js
// Authenticated callable that closes the self-join security hole.
// Before this callable, any signed-in user could create their own
// membership in any organization because firestore.rules allowed
// self-writes on organizations/{orgSlug}/members/{uid}.  With the
// rule tightened to admin-only CREATE, invite redemption must go
// through the Admin SDK (which bypasses rules).  This callable is
// the single sanctioned path: it verifies the invite server-side
// inside a transaction and creates the membership atomically.
//
// Invoked by the :slug/join page AFTER the user has an account.

import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const MAX_SLUG_LEN = 128
const MAX_CODE_LEN = 64

export const redeemInviteAndJoin = onCall(async (request) => {
  // ── 1. Auth guard ──────────────────────────────────────────────
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'You must be signed in to join an organization')
  }

  const uid = request.auth.uid

  // ── 2. Input validation ────────────────────────────────────────
  const { slug, code } = request.data || {}

  if (!slug || typeof slug !== 'string') {
    throw new HttpsError('invalid-argument', 'slug must be a non-empty string')
  }
  const trimmedSlug = slug.trim()
  if (!trimmedSlug || trimmedSlug.length > MAX_SLUG_LEN || trimmedSlug.includes('/')) {
    throw new HttpsError('invalid-argument', 'slug must be a non-empty string (max 128 chars) without "/"')
  }

  if (!code || typeof code !== 'string') {
    throw new HttpsError('invalid-argument', 'code must be a non-empty string')
  }
  const trimmedCode = code.trim()
  if (!trimmedCode || trimmedCode.length > MAX_CODE_LEN) {
    throw new HttpsError('invalid-argument', 'code must be a non-empty string (max 64 chars)')
  }

  try {
    const firestore = getFirestore()

    // ── 3. Validate the invite server-side ────────────────────────
    // Same generic failure for missing org, missing invite, expired,
    // or exhausted — so an attacker cannot probe which orgs exist.
    const orgRef = firestore.doc(`organizations/${trimmedSlug}`)
    const orgSnap = await orgRef.get()
    if (!orgSnap.exists) {
      throw new HttpsError('permission-denied', 'Invalid or expired invite code')
    }

    const invitesSnap = await firestore
      .collection(`organizations/${trimmedSlug}/invites`)
      .where('code', '==', trimmedCode)
      .limit(1)
      .get()

    if (invitesSnap.empty) {
      throw new HttpsError('permission-denied', 'Invalid or expired invite code')
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
        throw new HttpsError('permission-denied', 'Invalid or expired invite code')
      }
    }

    // Pre-check usage (non-authoritative; re-checked inside the transaction
    // to prevent TOCTOU races where two concurrent redemptions both pass).
    const maxUses = inviteData.maxUses || 0
    const usedCount = inviteData.usedCount || 0
    if (maxUses > 0 && usedCount >= maxUses) {
      throw new HttpsError('permission-denied', 'Invalid or expired invite code')
    }

    // ── 4. Atomic join via transaction ────────────────────────────
    const memberRef = firestore.doc(`organizations/${trimmedSlug}/members/${uid}`)
    const inviteRef = firestore.doc(`organizations/${trimmedSlug}/invites/${inviteId}`)
    const profileRef = firestore.doc(`userProfiles/${uid}`)

    // Build the member document from available auth claims.
    const displayName =
      request.auth.token?.name || request.auth.token?.displayName || null
    const email = request.auth.token?.email || null

    await firestore.runTransaction(async (t) => {
      // -- 4a. Idempotence: if already a member, succeed without mutation --
      const memberSnap = await t.get(memberRef)
      if (memberSnap.exists) {
        return // bail out; the caller is already a member
      }

      // -- 4b. Re-check usage limits inside the transaction --
      const freshInviteSnap = await t.get(inviteRef)
      if (!freshInviteSnap.exists) {
        throw new HttpsError('permission-denied', 'Invalid or expired invite code')
      }
      const freshData = freshInviteSnap.data()
      const freshMaxUses = freshData.maxUses || 0
      const freshUsedCount = freshData.usedCount || 0
      if (freshMaxUses > 0 && freshUsedCount >= freshMaxUses) {
        throw new HttpsError('permission-denied', 'Invalid or expired invite code')
      }

      // -- 4c. Re-check expiration inside the transaction --
      if (freshData.expiresAt != null) {
        const expiresAt =
          typeof freshData.expiresAt.toDate === 'function'
            ? freshData.expiresAt.toDate()
            : new Date(freshData.expiresAt)
        if (expiresAt < new Date()) {
          throw new HttpsError('permission-denied', 'Invalid or expired invite code')
        }
      }

      // -- 4d. Create the membership --
      t.create(memberRef, {
        role,
        name: displayName,
        email,
        joinedAt: FieldValue.serverTimestamp(),
        mfaEnrolled: false,
      })

      // -- 4e. Stamp the org slug on the user's profile --
      t.set(profileRef, { orgSlug: trimmedSlug }, { merge: true })

      // -- 4f. Increment usage on the invite --
      t.update(inviteRef, {
        usedCount: FieldValue.increment(1),
        usedBy: FieldValue.arrayUnion(uid),
      })
    })

    // ── 5. Audit ──────────────────────────────────────────────────
    try {
      await firestore.collection('platformAudit').add({
        actor: uid,
        actorEmail: request.auth.token?.email ?? null,
        action: 'join_org_via_invite',
        orgSlug: trimmedSlug,
        inviteId,
        at: FieldValue.serverTimestamp(),
      })
    } catch (err) {
      console.error('Audit write failed:', err)
      throw new HttpsError('internal', 'audit write failed')
    }

    // ── 6. Return minimal result ──────────────────────────────────
    return {
      success: true,
      role,
      orgSlug: trimmedSlug,
    }
  } catch (err) {
    // Re-throw HttpsError as-is so input/permission errors surface properly.
    if (err instanceof HttpsError) throw err
    // Log the real error but return a generic message to the caller.
    console.error('redeemInviteAndJoin internal error:', err)
    throw new HttpsError('internal', 'Unable to complete join')
  }
})
