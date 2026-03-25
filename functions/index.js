import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { defineSecret } from 'firebase-functions/params'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { mapFedExStatus } from './fedex-status.js'
import { mapUpsStatus } from './ups-status.js'

initializeApp()
const firestore = getFirestore()

const fedexApiKey = defineSecret('FEDEX_API_KEY')
const fedexSecretKey = defineSecret('FEDEX_SECRET_KEY')
const fedexMode = defineSecret('FEDEX_MODE')

const upsClientId = defineSecret('UPS_CLIENT_ID')
const upsClientSecret = defineSecret('UPS_CLIENT_SECRET')
const upsMode = defineSecret('UPS_MODE')

// Toggle between sandbox and production FedEx API
// Set FEDEX_MODE to "production" when you get prod keys approved
function getFedExBaseUrl() {
  try {
    if (fedexMode.value() === 'production') {
      return 'https://apis.fedex.com'
    }
  } catch {
    // Secret not set yet — default to sandbox
  }
  return 'https://apis-sandbox.fedex.com'
}

/**
 * Authenticate with FedEx OAuth2 and return an access token.
 */
async function getFedExToken(apiKey, secretKey) {
  const baseUrl = getFedExBaseUrl()
  console.log(`FedEx auth: using ${baseUrl}, key starts with: ${apiKey.trim().substring(0, 6)}...`)
  const res = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: apiKey.trim(),
      client_secret: secretKey.trim(),
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`FedEx auth failed (${res.status}): ${text}`)
  }

  const data = await res.json()
  return data.access_token
}

/**
 * Track a FedEx shipment by tracking number.
 *
 * Callable from the frontend via:
 *   import { getFunctions, httpsCallable } from 'firebase/functions'
 *   const trackFedEx = httpsCallable(getFunctions(), 'trackFedEx')
 *   const result = await trackFedEx({ trackingNumber: '123456789012' })
 */
export const trackFedEx = onCall(
  { secrets: [fedexApiKey, fedexSecretKey, fedexMode] },
  async (request) => {
    // Require authenticated user
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in to track shipments.')
    }

    const { trackingNumber } = request.data
    if (!trackingNumber || typeof trackingNumber !== 'string') {
      throw new HttpsError('invalid-argument', 'trackingNumber is required.')
    }

    try {
      const token = await getFedExToken(
        fedexApiKey.value(),
        fedexSecretKey.value()
      )

      const baseUrl = getFedExBaseUrl()
      const res = await fetch(`${baseUrl}/track/v1/trackingnumbers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          includeDetailedScans: false,
          trackingInfo: [
            {
              trackingNumberInfo: {
                trackingNumber: trackingNumber.trim(),
              },
            },
          ],
        }),
      })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`FedEx Track API error (${res.status}): ${text}`)
      }

      const data = await res.json()

      // Extract the relevant tracking result
      const trackResult =
        data?.output?.completeTrackResults?.[0]?.trackResults?.[0]

      if (!trackResult) {
        return { found: false, trackingNumber, status: null, details: null }
      }

      const latestStatus = trackResult.latestStatusDetail
      const dateAndTimes = trackResult.dateAndTimes || []
      const deliveryDate = dateAndTimes.find(
        (d) => d.type === 'ACTUAL_DELIVERY' || d.type === 'ESTIMATED_DELIVERY'
      )

      const mappedStatus = mapFedExStatus(latestStatus?.code)

      return {
        found: true,
        trackingNumber,
        status: latestStatus?.statusByLocale || latestStatus?.code || 'Unknown',
        statusCode: latestStatus?.code || null,
        mappedStatus,
        description: latestStatus?.description || null,
        deliveryDate: deliveryDate?.dateTime || null,
        deliveryType: deliveryDate?.type || null,
        shipperCity: trackResult.shipperInformation?.address?.city || null,
        recipientCity: trackResult.recipientInformation?.address?.city || null,
      }
    } catch (err) {
      console.error('FedEx tracking error:', err)
      throw new HttpsError('internal', err.message || 'Failed to track shipment.')
    }
  }
)

/**
 * Batch call FedEx Track API for up to 30 tracking numbers at once.
 * Returns a Map of trackingNumber → trackResult.
 */
async function fetchFedExTrackingBatch(token, trackingNumbers) {
  const results = new Map()
  if (trackingNumbers.length === 0) return results

  const baseUrl = getFedExBaseUrl()
  const res = await fetch(`${baseUrl}/track/v1/trackingnumbers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      includeDetailedScans: false,
      trackingInfo: trackingNumbers.map((tn) => ({
        trackingNumberInfo: { trackingNumber: tn.trim() },
      })),
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    console.error(`FedEx batch track failed (${res.status}): ${errText}`)
    return results
  }

  const data = await res.json()
  console.log(`FedEx raw response keys: ${JSON.stringify(Object.keys(data))}`)
  const completeResults = data?.output?.completeTrackResults || []

  for (const result of completeResults) {
    const trackResult = result?.trackResults?.[0]
    const tn = result?.trackingNumber
    console.log(`FedEx batch result for ${tn}: statusCode="${trackResult?.latestStatusDetail?.code}", status="${trackResult?.latestStatusDetail?.statusByLocale}", desc="${trackResult?.latestStatusDetail?.description}"`)
    if (tn && trackResult) {
      results.set(tn, trackResult)
    }
  }

  return results
}

/**
 * Refresh FedEx statuses for all active shipments in a given org.
 * Batches up to 30 tracking numbers per API call (1 call = 1 API transaction).
 * Called by both the scheduled job and the manual "Refresh All" button.
 */
async function syncFedExForOrg(orgSlug, apiKey, secretKey) {
  const shipmentsRef = firestore
    .collection('organizations')
    .doc(orgSlug)
    .collection('shipments')

  // Get all FedEx shipments that are NOT delivered (active ones to check)
  const snap = await shipmentsRef
    .where('carrier', '==', 'fedex')
    .where('status', 'in', ['pending', 'shipped', 'in_transit', 'exception'])
    .get()

  if (snap.empty) return { updated: 0, checked: 0, apiCalls: 0 }

  // Build a list of docs with tracking numbers
  const docsWithTracking = snap.docs.filter((d) => d.data().trackingNumber)
  if (docsWithTracking.length === 0) return { updated: 0, checked: 0, apiCalls: 0 }

  const token = await getFedExToken(apiKey, secretKey)
  let updated = 0
  let apiCalls = 0

  // Process in batches of 30 (FedEx max per request)
  const BATCH_SIZE = 30
  for (let i = 0; i < docsWithTracking.length; i += BATCH_SIZE) {
    const batch = docsWithTracking.slice(i, i + BATCH_SIZE)
    const trackingNumbers = batch.map((d) => d.data().trackingNumber)

    const trackResults = await fetchFedExTrackingBatch(token, trackingNumbers)
    apiCalls++

    for (const shipDoc of batch) {
      const shipment = shipDoc.data()
      const trackResult = trackResults.get(shipment.trackingNumber)
      if (!trackResult) continue

      const latestStatus = trackResult.latestStatusDetail
      console.log(`Tracking ${shipment.trackingNumber}: code="${latestStatus?.code}", description="${latestStatus?.description}", statusByLocale="${latestStatus?.statusByLocale}"`)
      const newStatus = mapFedExStatus(latestStatus?.code)

      if (newStatus && newStatus !== shipment.status) {
        const updates = {
          status: newStatus,
          fedexStatus: latestStatus?.statusByLocale || latestStatus?.code,
          fedexDescription: latestStatus?.description || null,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: 'system:fedex-sync',
        }

        if (newStatus === 'delivered') {
          updates.deliveredAt = FieldValue.serverTimestamp()
        }
        if (newStatus === 'shipped' && !shipment.shippedAt) {
          updates.shippedAt = FieldValue.serverTimestamp()
        }

        await shipDoc.ref.update(updates)
        updated++
      }
    }
  }

  return { updated, checked: docsWithTracking.length, apiCalls }
}

/**
 * Scheduled function: runs every 3 hours and syncs all active FedEx shipments
 * across all organizations.
 */
export const scheduledFedExSync = onSchedule(
  {
    schedule: '0 7,11,15,20 * * *',
    timeZone: 'America/Chicago',
    secrets: [fedexApiKey, fedexSecretKey],
  },
  async () => {
    const orgsSnap = await firestore.collection('organizations').get()
    let totalUpdated = 0
    let totalChecked = 0

    for (const orgDoc of orgsSnap.docs) {
      try {
        const result = await syncFedExForOrg(
          orgDoc.id,
          fedexApiKey.value(),
          fedexSecretKey.value()
        )
        totalUpdated += result.updated
        totalChecked += result.checked
      } catch (err) {
        console.error(`Sync failed for org ${orgDoc.id}:`, err.message)
      }
    }

    console.log(`FedEx sync complete: ${totalUpdated}/${totalChecked} shipments updated`)
  }
)

/**
 * Manual refresh: callable from frontend to sync all active FedEx shipments
 * for the user's organization right now.
 */
export const refreshFedExStatuses = onCall(
  { secrets: [fedexApiKey, fedexSecretKey, fedexMode] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in.')
    }

    const { orgSlug } = request.data
    if (!orgSlug || typeof orgSlug !== 'string') {
      throw new HttpsError('invalid-argument', 'orgSlug is required.')
    }

    try {
      const result = await syncFedExForOrg(
        orgSlug,
        fedexApiKey.value(),
        fedexSecretKey.value()
      )
      return result
    } catch (err) {
      console.error('Manual FedEx refresh error:', err)
      throw new HttpsError('internal', err.message || 'Failed to refresh statuses.')
    }
  }
)

// ─── UPS Integration ────────────────────────────────────────────────────────

/**
 * Toggle between sandbox and production UPS API.
 * Set UPS_MODE to "production" when your Tracking API is approved.
 */
function getUpsBaseUrl() {
  try {
    if (upsMode.value() === 'production') {
      return 'https://onlinetools.ups.com'
    }
  } catch {
    // Secret not set yet — default to sandbox
  }
  return 'https://wwwcie.ups.com'
}

/**
 * Authenticate with UPS OAuth2 and return an access token.
 * UPS uses HTTP Basic auth (base64 of clientId:clientSecret) to get a bearer token.
 */
async function getUpsToken(clientId, clientSecret) {
  const baseUrl = getUpsBaseUrl()
  const credentials = Buffer.from(`${clientId.trim()}:${clientSecret.trim()}`).toString('base64')

  const res = await fetch(`${baseUrl}/security/v1/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`UPS auth failed (${res.status}): ${text}`)
  }

  const data = await res.json()
  return data.access_token
}

/**
 * Track a single UPS shipment by tracking number.
 */
async function fetchUpsTracking(token, trackingNumber) {
  const baseUrl = getUpsBaseUrl()
  const res = await fetch(
    `${baseUrl}/api/track/v1/details/${encodeURIComponent(trackingNumber.trim())}?locale=en_US&returnSignature=false`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        transId: `track-${Date.now()}`,
        transactionSrc: 'Prescription_Delivery_Manifest',
      },
    }
  )

  if (!res.ok) {
    const text = await res.text()
    console.error(`UPS track failed for ${trackingNumber} (${res.status}): ${text}`)
    return null
  }

  return res.json()
}

/**
 * Track a UPS shipment by tracking number.
 * Callable from the frontend.
 */
export const trackUps = onCall(
  { secrets: [upsClientId, upsClientSecret, upsMode] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in to track shipments.')
    }

    const { trackingNumber } = request.data
    if (!trackingNumber || typeof trackingNumber !== 'string') {
      throw new HttpsError('invalid-argument', 'trackingNumber is required.')
    }

    try {
      const token = await getUpsToken(upsClientId.value(), upsClientSecret.value())
      const data = await fetchUpsTracking(token, trackingNumber.trim())

      if (!data) {
        return { found: false, trackingNumber, status: null, details: null }
      }

      const pkg = data?.trackResponse?.shipment?.[0]?.package?.[0]
      if (!pkg) {
        return { found: false, trackingNumber, status: null, details: null }
      }

      const currentStatus = pkg.currentStatus || pkg.activity?.[0]?.status
      const statusType = currentStatus?.type || null
      const mappedStatus = mapUpsStatus(statusType)

      const deliveryDate = pkg.deliveryDate?.[0]
      const deliveryTime = pkg.deliveryTime?.endTime || null

      return {
        found: true,
        trackingNumber,
        status: currentStatus?.description || 'Unknown',
        statusType,
        mappedStatus,
        description: currentStatus?.description || null,
        deliveryDate: deliveryDate?.date || null,
        deliveryTime,
        shipperCity: data?.trackResponse?.shipment?.[0]?.shipperAddress?.city || null,
        recipientCity: data?.trackResponse?.shipment?.[0]?.shipToAddress?.city || null,
      }
    } catch (err) {
      console.error('UPS tracking error:', err)
      throw new HttpsError('internal', err.message || 'Failed to track shipment.')
    }
  }
)

/**
 * Refresh UPS statuses for all active UPS shipments in a given org.
 * UPS doesn't support batch tracking, so we call one at a time with a small delay.
 */
async function syncUpsForOrg(orgSlug, clientId, clientSecret) {
  const shipmentsRef = firestore
    .collection('organizations')
    .doc(orgSlug)
    .collection('shipments')

  const snap = await shipmentsRef
    .where('carrier', '==', 'ups')
    .where('status', 'in', ['pending', 'shipped', 'in_transit', 'exception'])
    .get()

  if (snap.empty) return { updated: 0, checked: 0, apiCalls: 0 }

  const docsWithTracking = snap.docs.filter((d) => d.data().trackingNumber)
  if (docsWithTracking.length === 0) return { updated: 0, checked: 0, apiCalls: 0 }

  const token = await getUpsToken(clientId, clientSecret)
  let updated = 0
  let apiCalls = 0

  for (const shipDoc of docsWithTracking) {
    const shipment = shipDoc.data()

    try {
      const data = await fetchUpsTracking(token, shipment.trackingNumber)
      apiCalls++

      if (!data) continue

      const pkg = data?.trackResponse?.shipment?.[0]?.package?.[0]
      if (!pkg) continue

      const currentStatus = pkg.currentStatus || pkg.activity?.[0]?.status
      const statusType = currentStatus?.type || null
      const newStatus = mapUpsStatus(statusType)

      console.log(`UPS tracking ${shipment.trackingNumber}: type="${statusType}", desc="${currentStatus?.description}", mapped="${newStatus}"`)

      if (newStatus && newStatus !== shipment.status) {
        const updates = {
          status: newStatus,
          upsStatus: currentStatus?.description || statusType,
          upsDescription: currentStatus?.description || null,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: 'system:ups-sync',
        }

        if (newStatus === 'delivered') {
          updates.deliveredAt = FieldValue.serverTimestamp()
        }
        if (newStatus === 'shipped' && !shipment.shippedAt) {
          updates.shippedAt = FieldValue.serverTimestamp()
        }

        await shipDoc.ref.update(updates)
        updated++
      }
    } catch (err) {
      console.error(`UPS tracking failed for ${shipment.trackingNumber}:`, err.message)
    }

    // Small delay between calls to avoid rate limiting
    if (docsWithTracking.indexOf(shipDoc) < docsWithTracking.length - 1) {
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  return { updated, checked: docsWithTracking.length, apiCalls }
}

/**
 * Scheduled function: runs on the same schedule as FedEx and syncs all active
 * UPS shipments across all organizations.
 */
export const scheduledUpsSync = onSchedule(
  {
    schedule: '0 7,11,15,20 * * *',
    timeZone: 'America/Chicago',
    secrets: [upsClientId, upsClientSecret, upsMode],
  },
  async () => {
    const orgsSnap = await firestore.collection('organizations').get()
    let totalUpdated = 0
    let totalChecked = 0

    for (const orgDoc of orgsSnap.docs) {
      try {
        const result = await syncUpsForOrg(
          orgDoc.id,
          upsClientId.value(),
          upsClientSecret.value()
        )
        totalUpdated += result.updated
        totalChecked += result.checked
      } catch (err) {
        console.error(`UPS sync failed for org ${orgDoc.id}:`, err.message)
      }
    }

    console.log(`UPS sync complete: ${totalUpdated}/${totalChecked} shipments updated`)
  }
)

/**
 * Manual refresh: callable from frontend to sync all active UPS shipments
 * for the user's organization right now.
 */
export const refreshUpsStatuses = onCall(
  { secrets: [upsClientId, upsClientSecret, upsMode] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in.')
    }

    const { orgSlug } = request.data
    if (!orgSlug || typeof orgSlug !== 'string') {
      throw new HttpsError('invalid-argument', 'orgSlug is required.')
    }

    try {
      const result = await syncUpsForOrg(
        orgSlug,
        upsClientId.value(),
        upsClientSecret.value()
      )
      return result
    } catch (err) {
      console.error('Manual UPS refresh error:', err)
      throw new HttpsError('internal', err.message || 'Failed to refresh UPS statuses.')
    }
  }
)
