import { SecretManagerServiceClient } from '@google-cloud/secret-manager'
import { getFirestore } from 'firebase-admin/firestore'

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'delivery-manifest-c3deb'

let _client = null
function client() {
  if (!_client) _client = new SecretManagerServiceClient()
  return _client
}

export function secretNameFor(orgSlug) {
  return `projects/${PROJECT_ID}/secrets/textmsg-rc-creds-${orgSlug}/versions/latest`
}

/**
 * Returns {clientId, clientSecret, jwt, server, fromNumber} for the given org.
 * Sensitive fields come from Secret Manager, non-sensitive from the
 * textMessaging Firestore doc. Throws if either source is incomplete.
 */
export async function getRingCentralCredsForOrg(orgSlug) {
  if (!orgSlug || typeof orgSlug !== 'string') {
    throw new Error('getRingCentralCredsForOrg: orgSlug is required')
  }

  // Read non-sensitive bits from Firestore
  const firestore = getFirestore()
  const snap = await firestore.doc(`organizations/${orgSlug}/settings/textMessaging`).get()
  if (!snap.exists) {
    throw new Error(`No textMessaging settings for org ${orgSlug}`)
  }
  const settings = snap.data()
  const server = settings.ringcentral?.server
  const fromNumber = settings.ringcentral?.fromNumber
  if (!server || !fromNumber) {
    throw new Error(`textMessaging settings for ${orgSlug} missing server or fromNumber`)
  }

  // Read sensitive bits from Secret Manager
  let payload
  try {
    const [version] = await client().accessSecretVersion({ name: secretNameFor(orgSlug) })
    payload = version.payload?.data?.toString('utf8')
  } catch (e) {
    throw new Error(`Could not read RC creds secret for ${orgSlug}: ${e.message}`)
  }
  if (!payload) {
    throw new Error(`Empty RC creds secret for ${orgSlug}`)
  }

  let parsed
  try {
    parsed = JSON.parse(payload)
  } catch (e) {
    throw new Error(`RC creds secret for ${orgSlug} is not valid JSON`)
  }

  const { clientId, clientSecret, jwt } = parsed
  if (!clientId || !clientSecret || !jwt) {
    throw new Error(`RC creds secret for ${orgSlug} missing clientId/clientSecret/jwt`)
  }

  return { clientId, clientSecret, jwt, server, fromNumber }
}

// Internal: for tests to inject a fake client
export function _setClient(c) { _client = c }
