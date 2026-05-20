import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { getRingCentralCredsForOrg } from './lib/rcCredentials.js'
import { getAccessToken } from './ringcentral-auth.js'

const WEBHOOK_URL_BASE = 'https://us-central1-delivery-manifest-c3deb.cloudfunctions.net/ringcentralInbound'

async function requireAdmin(request, orgSlug) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
  const firestore = getFirestore()
  const memberSnap = await firestore.doc(`organizations/${orgSlug}/members/${request.auth.uid}`).get()
  if (!memberSnap.exists || memberSnap.data().role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin access required')
  }
}

export const registerRcWebhook = onCall(async (request) => {
  const { orgSlug } = request.data || {}
  if (!orgSlug) throw new HttpsError('invalid-argument', 'orgSlug required')
  await requireAdmin(request, orgSlug)

  const firestore = getFirestore()
  const settingsRef = firestore.doc(`organizations/${orgSlug}/settings/textMessaging`)
  const settingsSnap = await settingsRef.get()
  const settings = settingsSnap.exists ? settingsSnap.data() : null

  if (!settings?.enabled) throw new HttpsError('failed-precondition', 'Text messaging is not enabled')
  if (!settings?.credsConfigured) throw new HttpsError('failed-precondition', 'Credentials not configured')
  if (!settings?.webhookToken) throw new HttpsError('failed-precondition', 'Generate a webhook token first')

  // Delete existing subscription if present
  if (settings.webhookSubscriptionId) {
    try {
      const creds = await getRingCentralCredsForOrg(orgSlug)
      const token = await getAccessToken(creds)
      await fetch(`${creds.server}/restapi/v1.0/subscription/${settings.webhookSubscriptionId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
    } catch {
      // Best effort — existing subscription may already be gone
    }
  }

  const creds = await getRingCentralCredsForOrg(orgSlug)
  const token = await getAccessToken(creds)

  const webhookUrl = `${WEBHOOK_URL_BASE}?org=${encodeURIComponent(orgSlug)}&t=${encodeURIComponent(settings.webhookToken)}`

  const res = await fetch(`${creds.server}/restapi/v1.0/subscription`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      eventFilters: ['/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS'],
      deliveryMode: {
        transportType: 'WebHook',
        address: webhookUrl,
      },
      expiresIn: 604800, // 7 days; renewal scheduled daily
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new HttpsError('internal', `RingCentral subscription failed (${res.status}): ${body}`)
  }

  const data = await res.json()
  const expiresAt = new Date(data.expirationTime || Date.now() + 604800000)

  await settingsRef.set({
    webhookSubscriptionId: data.id,
    webhookExpiresAt: expiresAt,
    webhookRegisteredAt: FieldValue.serverTimestamp(),
  }, { merge: true })

  return { ok: true, subscriptionId: data.id, expiresAt: expiresAt.toISOString() }
})

export const deregisterRcWebhook = onCall(async (request) => {
  const { orgSlug } = request.data || {}
  if (!orgSlug) throw new HttpsError('invalid-argument', 'orgSlug required')
  await requireAdmin(request, orgSlug)

  const firestore = getFirestore()
  const settingsRef = firestore.doc(`organizations/${orgSlug}/settings/textMessaging`)
  const settingsSnap = await settingsRef.get()
  const settings = settingsSnap.exists ? settingsSnap.data() : null
  const subscriptionId = settings?.webhookSubscriptionId

  if (subscriptionId) {
    try {
      const creds = await getRingCentralCredsForOrg(orgSlug)
      const token = await getAccessToken(creds)
      await fetch(`${creds.server}/restapi/v1.0/subscription/${subscriptionId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
    } catch {
      // Proceed even if RC delete fails — clean up Firestore anyway
    }
  }

  await settingsRef.set({
    webhookSubscriptionId: null,
    webhookExpiresAt: null,
  }, { merge: true })

  return { ok: true }
})
