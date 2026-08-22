// functions/staff-lifecycle.js
// Admin-only callables for managing staff accounts end-to-end. A staff member
// is THREE records: the Firebase Auth login, userProfiles/{uid}, and
// organizations/{slug}/members/{uid}. The browser SDK can only delete the
// member doc, so a removed staff member's login used to survive and hold the
// email forever, blocking re-adding them with "email already in use". These
// callables use the Admin SDK to act on all three records together.
//
//   resendStaffInvite({ slug, memberId }) -> { email, link }
//     Returns the email-verification link for an existing member so the admin
//     can deliver it by any channel. No mail transport is configured in this
//     project, so returning the link is the honest contract — nothing is sent.
//
//   removeStaffAccount({ slug, memberId }) -> { success }
//     Deletes ALL THREE records (auth user, profile, member doc). Refuses to
//     remove the last remaining admin of the org and deletes NOTHING then. If
//     the auth account is already gone (auth/user-not-found) it still clears
//     both Firestore records so a half-cleaned state is recoverable.
//
//   linkExistingStaff({ slug, email, name, role }) -> { success }
//     Adopts an orphaned login (one that exists in Auth but has no
//     member/profile records) at its EXISTING uid — never creates a second
//     account, because a new account can never reuse that email.

import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'

const MAX_SLUG_LEN = 128
const MAX_EMAIL_LEN = 254
const MAX_NAME_LEN = 120
const MAX_ROLE_LEN = 32

// ── shared input validation ───────────────────────────────────────
function assertValidSlug(slug) {
  if (typeof slug !== 'string' || slug.trim() === '') {
    throw new HttpsError('invalid-argument', 'slug must be a non-empty string')
  }
  const trimmed = slug.trim()
  if (trimmed.length > MAX_SLUG_LEN || trimmed.includes('/')) {
    throw new HttpsError('invalid-argument', 'slug must be at most 128 chars and must not contain "/"')
  }
  return trimmed
}

// ── admin gate ────────────────────────────────────────────────────
// "Admin" means the CALLER's member doc for THAT org has role === 'admin',
// mirroring the gate in archive-shipments.js / backfill-archived.js.
async function assertOrgAdmin(firestore, orgSlug, uid) {
  const memberSnap = await firestore
    .doc(`organizations/${orgSlug}/members/${uid}`)
    .get()
  if (!memberSnap.exists || memberSnap.data().role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin access required')
  }
}

// ════════════════════════════════════════════════════════════════════
// resendStaffInvite — hand the admin a fresh verification link for an
// existing member, to be delivered by any channel the admin chooses.
// ════════════════════════════════════════════════════════════════════
export const resendStaffInvite = onCall(async (request) => {
  // ── auth ────────────────────────────────────────────────────────
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login required')
  }

  // ── input validation ────────────────────────────────────────────
  const { slug, memberId } = request.data || {}
  const orgSlug = assertValidSlug(slug)
  if (typeof memberId !== 'string' || memberId.trim() === '') {
    throw new HttpsError('invalid-argument', 'memberId must be a non-empty string')
  }
  const targetUid = memberId.trim()

  // ── admin check ─────────────────────────────────────────────────
  const firestore = getFirestore()
  await assertOrgAdmin(firestore, orgSlug, request.auth.uid)

  // ── the member must actually belong to the org ──────────────────
  const memberSnap = await firestore
    .doc(`organizations/${orgSlug}/members/${targetUid}`)
    .get()
  if (!memberSnap.exists) {
    throw new HttpsError('not-found', 'No member with that id in this organization')
  }

  const memberData = memberSnap.data()
  const link = await getAuth().generateEmailVerificationLink(memberData.email)
  return { email: memberData.email, link }
})

// ════════════════════════════════════════════════════════════════════
// removeStaffAccount — delete ALL THREE records of a staff member: the
// auth login, userProfiles/{uid}, and organizations/{slug}/members/{uid}.
// Deleting fewer is the original bug that stranded a login.
// ════════════════════════════════════════════════════════════════════
export const removeStaffAccount = onCall(async (request) => {
  // ── auth ────────────────────────────────────────────────────────
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login required')
  }

  // ── input validation ────────────────────────────────────────────
  const { slug, memberId } = request.data || {}
  const orgSlug = assertValidSlug(slug)
  if (typeof memberId !== 'string' || memberId.trim() === '') {
    throw new HttpsError('invalid-argument', 'memberId must be a non-empty string')
  }
  const targetUid = memberId.trim()

  // ── admin check ─────────────────────────────────────────────────
  const firestore = getFirestore()
  await assertOrgAdmin(firestore, orgSlug, request.auth.uid)

  // ── the target must actually be a member of the org ─────────────
  const memberSnap = await firestore
    .doc(`organizations/${orgSlug}/members/${targetUid}`)
    .get()
  if (!memberSnap.exists) {
    throw new HttpsError('not-found', 'No member with that id in this organization')
  }
  const memberData = memberSnap.data()

  // ── refuse to strip the org of its LAST admin ───────────────────
  // Checked BEFORE any deletion so a refusal is fully reversible: no auth
  // deletion, no document deletion.
  const adminsSnap = await firestore
    .collection(`organizations/${orgSlug}/members`)
    .where('role', '==', 'admin')
    .get()
  const adminCount = adminsSnap.docs.length
  if (memberData.role === 'admin' && adminCount === 1) {
    throw new HttpsError(
      'failed-precondition',
      'Cannot remove the last remaining admin of the organization',
    )
  }

  // ── 1. Auth login ───────────────────────────────────────────────
  // A half-cleaned state (login already gone) must be recoverable, not
  // fatal: catch ONLY 'auth/user-not-found' and keep going. Everything else
  // re-throws — never silently swallow other errors.
  try {
    await getAuth().deleteUser(targetUid)
  } catch (err) {
    if (!err || err.code !== 'auth/user-not-found') throw err
  }

  // ── 2. userProfiles/{uid} ───────────────────────────────────────
  await firestore.doc(`userProfiles/${targetUid}`).delete()

  // ── 3. organizations/{slug}/members/{uid} ───────────────────────
  await firestore.doc(`organizations/${orgSlug}/members/${targetUid}`).delete()

  return { success: true }
})

// ════════════════════════════════════════════════════════════════════
// linkExistingStaff — adopt an orphaned login (an Auth account that exists
// but has no member/profile records) at its EXISTING uid. A new account can
// never reuse that email, so the only honest adoption is against the uid
// getUserByEmail returns — createUser is never called.
// ════════════════════════════════════════════════════════════════════
export const linkExistingStaff = onCall(async (request) => {
  // ── auth ────────────────────────────────────────────────────────
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login required')
  }

  // ── input validation ────────────────────────────────────────────
  const { slug, email, name, role } = request.data || {}
  const orgSlug = assertValidSlug(slug)

  if (typeof email !== 'string' || email.trim() === '') {
    throw new HttpsError('invalid-argument', 'email must be a non-empty string')
  }
  const trimmedEmail = email.trim()
  if (trimmedEmail.length > MAX_EMAIL_LEN || !trimmedEmail.includes('@')) {
    throw new HttpsError('invalid-argument', 'email must be a valid email address')
  }

  if (typeof name !== 'string' || name.trim() === '') {
    throw new HttpsError('invalid-argument', 'name must be a non-empty string')
  }
  const trimmedName = name.trim()
  if (trimmedName.length > MAX_NAME_LEN) {
    throw new HttpsError('invalid-argument', 'name must be at most 120 chars')
  }

  if (typeof role !== 'string' || role.trim() === '') {
    throw new HttpsError('invalid-argument', 'role must be a non-empty string')
  }
  const trimmedRole = role.trim()
  if (trimmedRole.length > MAX_ROLE_LEN) {
    throw new HttpsError('invalid-argument', 'role must be at most 32 chars')
  }

  // ── admin check ─────────────────────────────────────────────────
  const firestore = getFirestore()
  await assertOrgAdmin(firestore, orgSlug, request.auth.uid)

  // ── find the orphaned login at its EXISTING uid ─────────────────
  // No account -> tell the caller to send a normal invite instead;
  // half-writing records under a dead uid would strand the person again.
  let authUser
  try {
    authUser = await getAuth().getUserByEmail(trimmedEmail)
  } catch (err) {
    if (err && err.code === 'auth/user-not-found') {
      throw new HttpsError(
        'not-found',
        'No auth account exists for that email — send a normal invite instead',
      )
    }
    throw err
  }

  const uid = authUser.uid

  // ── refuse adoption if a member doc already exists for this uid ─
  // An existing member record means this login is NOT orphaned in this
  // org. Overwriting it would destroy the stored role, joinedAt, and
  // mfaEnrolled — so refuse and point the caller at the normal edit path.
  const existingMemberSnap = await firestore
    .doc(`organizations/${orgSlug}/members/${uid}`)
    .get()
  if (existingMemberSnap.exists) {
    throw new HttpsError(
      'failed-precondition',
      'That person is already a member of this organization — use the normal edit path to update their role or profile instead of adopting an existing login',
    )
  }

  // ── 1. organizations/{slug}/members/{uid} ───────────────────────
  await firestore.doc(`organizations/${orgSlug}/members/${uid}`).set({
    role: trimmedRole,
    name: trimmedName,
    email: trimmedEmail,
    joinedAt: FieldValue.serverTimestamp(),
    mfaEnrolled: false,
  })

  // ── 2. userProfiles/{uid} ───────────────────────────────────────
  await firestore.doc(`userProfiles/${uid}`).set({
    displayName: trimmedName,
    email: trimmedEmail,
  })

  return { success: true }
})
