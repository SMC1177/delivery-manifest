import { HttpsError } from 'firebase-functions/v2/https'
import { getFirestore } from 'firebase-admin/firestore'

export async function requirePlatformAdmin(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login required')
  }

  const firestore = getFirestore()
  const profileSnap = await firestore.doc(`userProfiles/${request.auth.uid}`).get()

  if (!profileSnap.exists || profileSnap.data().platformAdmin !== true) {
    throw new HttpsError('permission-denied', 'Admin access required')
  }

  return {
    uid: request.auth.uid,
    email: request.auth.token?.email ?? null,
  }
}
