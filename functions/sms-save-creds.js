import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { SecretManagerServiceClient } from '@google-cloud/secret-manager'
import { normalizePhone } from './lib/phoneNormalize.js'

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'delivery-manifest-c3deb'

let _client = null
function client() {
  if (!_client) _client = new SecretManagerServiceClient()
  return _client
}

// Internal: for tests to inject a fake client
export function _setClient(c) { _client = c }

function secretId(orgSlug) {
  return `textmsg-rc-creds-${orgSlug}`
}

function secretParent() {
  return `projects/${PROJECT_ID}`
}

function secretFullName(orgSlug) {
  return `projects/${PROJECT_ID}/secrets/${secretId(orgSlug)}`
}

/**
 * Admin-only callable. Stores RingCentral credentials for an org:
 *   - server, fromNumber → Firestore organizations/{slug}/settings/textMessaging
 *   - clientId, clientSecret, jwt → Secret Manager textmsg-rc-creds-{slug}
 * Sets credsConfigured=true and credsUpdatedAt on the Firestore doc.
 */
export const saveRingCentralCreds = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in.')
  }

  const raw = request.data || {}
  const { orgSlug, server, fromNumber } = raw
  const clientId = typeof raw.clientId === 'string' ? raw.clientId.trim() : raw.clientId
  const clientSecret = typeof raw.clientSecret === 'string' ? raw.clientSecret.trim() : raw.clientSecret
  const jwt = typeof raw.jwt === 'string' ? raw.jwt.trim() : raw.jwt

  // Validate clientId — must be a non-empty string without @ (autofill signature)
  if (!clientId || typeof clientId !== 'string' || clientId === '') {
    throw new HttpsError(
      'invalid-argument',
      'clientId is required and must be a non-empty string. '
      + 'Because credentials are stored as one secret, you must re-enter clientId, clientSecret and jwt together — partial saves are not supported.',
    )
  }
  if (clientId.includes('@')) {
    throw new HttpsError(
      'invalid-argument',
      'clientId looks like an email address — browser autofill may have filled it in. '
      + 'A RingCentral Client ID is an opaque token, never an email. Clear the field and re-enter the correct value.',
    )
  }

  // Validate clientSecret
  if (!clientSecret || typeof clientSecret !== 'string' || clientSecret === '') {
    throw new HttpsError(
      'invalid-argument',
      'clientSecret is required and must be a non-empty string. '
      + 'Because credentials are stored as one secret, you must re-enter clientId, clientSecret and jwt together — partial saves are not supported.',
    )
  }

  // Validate jwt
  if (!jwt || typeof jwt !== 'string' || jwt === '') {
    throw new HttpsError(
      'invalid-argument',
      'jwt is required and must be a non-empty string. '
      + 'Because credentials are stored as one secret, you must re-enter clientId, clientSecret and jwt together — partial saves are not supported.',
    )
  }

  if (!orgSlug || !server || !fromNumber) {
    throw new HttpsError('invalid-argument', 'orgSlug, server, and fromNumber are all required')
  }
  if (typeof orgSlug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/i.test(orgSlug)) {
    throw new HttpsError('invalid-argument', 'orgSlug must be a valid identifier')
  }

  // Validate fromNumber at the boundary — reject a malformed sender number with
  // a clear message instead of storing it and failing later at send time (MSG-245).
  let normalizedFromNumber
  try {
    normalizedFromNumber = normalizePhone(fromNumber)
  } catch (err) {
    throw new HttpsError(
      'invalid-argument',
      `fromNumber must be a valid US phone number (10 digits, optional leading 1). Got: "${fromNumber}"`,
    )
  }

  const firestore = getFirestore()

  // Admin role check
  const memberSnap = await firestore.doc(`organizations/${orgSlug}/members/${request.auth.uid}`).get()
  if (!memberSnap.exists || memberSnap.data().role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only admins can save text messaging credentials.')
  }

  // 1. Write sensitive creds to Secret Manager
  const payload = Buffer.from(JSON.stringify({ clientId, clientSecret, jwt }), 'utf8')
  const sm = client()

  // Create secret if absent
  try {
    await sm.createSecret({
      parent: secretParent(),
      secretId: secretId(orgSlug),
      secret: { replication: { automatic: {} } },
    })
  } catch (e) {
    // ALREADY_EXISTS is fine; rethrow anything else
    const isAlreadyExists = (e?.code === 6) || /ALREADY_EXISTS/i.test(String(e?.message ?? ''))
    if (!isAlreadyExists) {
      throw new HttpsError('internal', `Secret Manager createSecret failed: ${e.message || e}`)
    }
  }

  // Always add a new version
  try {
    await sm.addSecretVersion({
      parent: secretFullName(orgSlug),
      payload: { data: payload },
    })
  } catch (e) {
    throw new HttpsError('internal', `Secret Manager addSecretVersion failed: ${e.message || e}`)
  }

  // 2. Write non-sensitive fields to Firestore
  await firestore.doc(`organizations/${orgSlug}/settings/textMessaging`).set(
    {
      ringcentral: { server, fromNumber: normalizedFromNumber },
      credsConfigured: true,
      credsUpdatedAt: FieldValue.serverTimestamp(),
      credsUpdatedBy: request.auth.uid,
    },
    { merge: true },
  )

  // 3. Audit log
  await firestore.collection(`organizations/${orgSlug}/auditLog`).add({
    action: 'sms.settings_changed',
    targetId: 'ringcentral',
    details: { field: 'ringcentral', credsConfigured: true },
    userId: request.auth.uid,
    timestamp: FieldValue.serverTimestamp(),
  })

  return { ok: true }
})
