import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { onDocumentCreated } from 'firebase-functions/v2/firestore'
import { defineSecret } from 'firebase-functions/params'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { mapFedExStatus } from './fedex-status.js'
import { mapUpsStatus, deriveUpsStatusContext, isStaleDelivery } from './ups-status.js'
import { detectCarrier } from './carrier-detection.js'
import { handleTrackAlertWebhook, subscribeTrackingNumbers } from './ups-track-alert.js'

initializeApp()
const firestore = getFirestore()

const fedexApiKey = defineSecret('FEDEX_API_KEY')
const fedexSecretKey = defineSecret('FEDEX_SECRET_KEY')
const fedexMode = defineSecret('FEDEX_MODE')

const upsClientId = defineSecret('UPS_CLIENT_ID')
const upsClientSecret = defineSecret('UPS_CLIENT_SECRET')
const upsMode = defineSecret('UPS_MODE')
const trackAlertWebhookSecret = defineSecret('TRACK_ALERT_WEBHOOK_SECRET')

// FedEx API — defaults to production
// Set FEDEX_MODE to "sandbox" to use sandbox for testing
function getFedExBaseUrl() {
  try {
    if (fedexMode.value() === 'sandbox') {
      return 'https://apis-sandbox.fedex.com'
    }
  } catch {
    // Secret not set yet — default to production
  }
  return 'https://apis.fedex.com'
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
 * Batches 30 tracking numbers per API call, processes 5 batches in parallel,
 * and writes updates in Firestore batches of 500.
 */
async function syncFedExForOrg(orgSlug, apiKey, secretKey) {
  const shipmentsRef = firestore
    .collection('organizations')
    .doc(orgSlug)
    .collection('shipments')

  // Read org-level polling max days (default 60)
  const orgDoc = await firestore.collection('organizations').doc(orgSlug).get()
  const maxPollingDays = orgDoc.exists ? (orgDoc.data()?.settings?.maxPollingDays ?? 60) : 60
  const cutoffDate = new Date(Date.now() - maxPollingDays * 24 * 60 * 60 * 1000)

  // Get all FedEx shipments that are NOT delivered (active ones to check)
  const snap = await shipmentsRef
    .where('carrier', '==', 'fedex')
    .where('status', 'in', ['pending', 'shipped', 'in_transit', 'exception'])
    .get()

  if (snap.empty) return { updated: 0, checked: 0, apiCalls: 0, skippedStale: 0 }

  // Filter out shipments older than maxPollingDays
  let skippedStale = 0
  const freshDocs = snap.docs.filter((d) => {
    const data = d.data()
    const createdAt = data.createdAt?.toDate?.() || (data.createdAt?._seconds ? new Date(data.createdAt._seconds * 1000) : null)
    if (createdAt && createdAt < cutoffDate) { skippedStale++; return false }
    return true
  })

  // Build a list of docs with tracking numbers
  const docsWithTracking = freshDocs.filter((d) => d.data().trackingNumber)
  if (docsWithTracking.length === 0) return { updated: 0, checked: 0, apiCalls: 0, skippedStale }

  // Dedupe: group all docs by tracking number so each number is polled only once
  const byTracking = new Map()
  for (const shipDoc of docsWithTracking) {
    const tn = shipDoc.data().trackingNumber.trim()
    if (!byTracking.has(tn)) byTracking.set(tn, [])
    byTracking.get(tn).push(shipDoc)
  }
  const uniqueTrackingNumbers = [...byTracking.keys()]
  console.log(`FedEx sync for ${orgSlug}: ${docsWithTracking.length} docs (${skippedStale} stale skipped), ${uniqueTrackingNumbers.length} unique tracking numbers, maxPollingDays=${maxPollingDays}`)

  const token = await getFedExToken(apiKey, secretKey)
  let updated = 0
  let apiCalls = 0

  // Split unique tracking numbers into batches of 30 (FedEx max per request)
  const BATCH_SIZE = 30
  const apiBatches = []
  for (let i = 0; i < uniqueTrackingNumbers.length; i += BATCH_SIZE) {
    apiBatches.push(uniqueTrackingNumbers.slice(i, i + BATCH_SIZE))
  }

  // Process API batches in parallel chunks of 5 to avoid rate limits
  const PARALLEL = 5
  for (let i = 0; i < apiBatches.length; i += PARALLEL) {
    const chunk = apiBatches.slice(i, i + PARALLEL)
    const results = await Promise.allSettled(
      chunk.map(async (trackingBatch) => {
        const trackResults = await fetchFedExTrackingBatch(token, trackingBatch)
        return trackResults
      })
    )

    apiCalls += chunk.length

    // Collect all updates — apply each API result to ALL docs sharing that tracking number
    const pendingUpdates = []
    for (const result of results) {
      if (result.status !== 'fulfilled') {
        console.error('FedEx batch failed:', result.reason?.message)
        continue
      }
      const trackResults = result.value
      for (const [tn, trackResult] of trackResults) {
        const latestStatus = trackResult.latestStatusDetail
        const newStatus = mapFedExStatus(latestStatus?.code)
        if (!newStatus) continue

        // Apply to every doc with this tracking number
        for (const shipDoc of (byTracking.get(tn) || [])) {
          const shipment = shipDoc.data()
          if (newStatus === shipment.status) continue

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
          pendingUpdates.push({ ref: shipDoc.ref, updates })
        }
      }
    }

    // Batched Firestore writes (max 500 per batch)
    const WRITE_BATCH_SIZE = 500
    for (let w = 0; w < pendingUpdates.length; w += WRITE_BATCH_SIZE) {
      const writeBatch = firestore.batch()
      const slice = pendingUpdates.slice(w, w + WRITE_BATCH_SIZE)
      for (const { ref, updates } of slice) {
        writeBatch.update(ref, updates)
      }
      await writeBatch.commit()
      updated += slice.length
    }
  }

  console.log(`FedEx sync for ${orgSlug}: ${updated}/${docsWithTracking.length} docs updated, ${apiCalls} API calls (${uniqueTrackingNumbers.length} unique TNs), ${skippedStale} stale skipped`)
  return { updated, checked: docsWithTracking.length, apiCalls, skippedStale }
}

/**
 * Scheduled function: runs daily at 7 AM CT and syncs all active FedEx shipments
 * across all organizations.
 */
export const scheduledFedExSync = onSchedule(
  {
    schedule: '0 7 * * *',
    timeZone: 'America/Chicago',
    secrets: [fedexApiKey, fedexSecretKey, fedexMode],
    timeoutSeconds: 540,
    memory: '1GiB',
  },
  async () => {
    const orgsSnap = await firestore.collection('organizations').get()
    if (orgsSnap.empty) {
      console.log('FedEx sync: no organizations found, skipping.')
      return
    }
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

// ─── USPS ───────────────────────────────────────────────────────────────────
// USPS tracking numbers: start with 9, 20-22 digits.
// USPS uses XML-based Web Tools API (not OAuth REST like FedEx/UPS).
// No scheduled sync implemented — tracking is handled via client-side URL only.
// If USPS REST API becomes available, add secrets and sync here.
// detectCarrier() is exported from ./carrier-detection.js

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
    `${baseUrl}/api/track/v1/details/${encodeURIComponent(trackingNumber.trim())}?locale=en_US&returnSignature=false&returnMilestones=true&returnPOD=true`,
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

      const statusContext = deriveUpsStatusContext(pkg)
      const mappedStatus = mapUpsStatus(statusContext)

      const deliveryDate = pkg.deliveryDate?.[0]
      const deliveryTime = pkg.deliveryTime?.endTime || null

      return {
        found: true,
        trackingNumber,
        status: statusContext.description || 'Unknown',
        statusCode: statusContext.code,
        mappedStatus,
        description: statusContext.description || null,
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
 * Processes 3 tracking calls in parallel with batched Firestore writes.
 */
async function syncUpsForOrg(orgSlug, clientId, clientSecret) {
  const shipmentsRef = firestore
    .collection('organizations')
    .doc(orgSlug)
    .collection('shipments')

  // Read org-level polling max days (default 60)
  const orgDoc = await firestore.collection('organizations').doc(orgSlug).get()
  const maxPollingDays = orgDoc.exists ? (orgDoc.data()?.settings?.maxPollingDays ?? 60) : 60
  const cutoffDate = new Date(Date.now() - maxPollingDays * 24 * 60 * 60 * 1000)

  // Query both lowercase 'ups' and legacy uppercase 'UPS' — old records may not be normalized
  const [snapLower, snapUpper] = await Promise.all([
    shipmentsRef.where('carrier', '==', 'ups').where('status', 'in', ['pending', 'shipped', 'in_transit', 'exception']).get(),
    shipmentsRef.where('carrier', '==', 'UPS').where('status', 'in', ['pending', 'shipped', 'in_transit', 'exception']).get(),
  ])
  const allDocs = [...snapLower.docs, ...snapUpper.docs]
  if (snapUpper.docs.length > 0) {
    console.log(`UPS sync for ${orgSlug}: found ${snapUpper.docs.length} docs with legacy uppercase carrier 'UPS'`)
  }

  const snap = { empty: allDocs.length === 0, docs: allDocs }
  if (snap.empty) return { updated: 0, checked: 0, apiCalls: 0, skippedStale: 0 }

  // Filter out shipments older than maxPollingDays
  let skippedStale = 0
  const freshDocs = snap.docs.filter((d) => {
    const data = d.data()
    const createdAt = data.createdAt?.toDate?.() || (data.createdAt?._seconds ? new Date(data.createdAt._seconds * 1000) : null)
    if (createdAt && createdAt < cutoffDate) { skippedStale++; return false }
    return true
  })

  const docsWithTracking = freshDocs.filter((d) => d.data().trackingNumber)
  if (docsWithTracking.length === 0) return { updated: 0, checked: 0, apiCalls: 0, skippedStale }

  // Dedupe: group all docs by tracking number so each number is polled only once
  const byTracking = new Map()
  for (const shipDoc of docsWithTracking) {
    const tn = shipDoc.data().trackingNumber.trim()
    if (!byTracking.has(tn)) byTracking.set(tn, [])
    byTracking.get(tn).push(shipDoc)
  }
  const uniqueTrackingNumbers = [...byTracking.keys()]
  console.log(`UPS sync for ${orgSlug}: ${docsWithTracking.length} docs (${skippedStale} stale skipped), ${uniqueTrackingNumbers.length} unique tracking numbers, maxPollingDays=${maxPollingDays}`)

  const token = await getUpsToken(clientId, clientSecret)
  let updated = 0
  let apiCalls = 0
  const pendingUpdates = []

  // UPS has no batch API — process 3 unique tracking numbers at a time
  const PARALLEL = 3
  for (let i = 0; i < uniqueTrackingNumbers.length; i += PARALLEL) {
    const chunk = uniqueTrackingNumbers.slice(i, i + PARALLEL)
    const results = await Promise.allSettled(
      chunk.map(async (tn) => {
        const data = await fetchUpsTracking(token, tn)
        apiCalls++
        if (!data) return null

        const pkg = data?.trackResponse?.shipment?.[0]?.package?.[0]
        if (!pkg) return null

        // Sort activity newest-first by UPS date+time strings (YYYYMMDD + HHMMSS)
        const sortedActivity = [...(pkg.activity || [])].sort((a, b) => {
          const da = `${a.date || ''}${a.time || ''}`
          const db = `${b.date || ''}${b.time || ''}`
          return db.localeCompare(da)
        })
        const latestActivity = sortedActivity[0]
        const statusContext = deriveUpsStatusContext(pkg)
        if (!statusContext.type && !statusContext.code && !statusContext.description) {
          console.warn(`UPS sync: no status context for TN ${tn}, statusContext=${JSON.stringify(statusContext)}`)
        }
        const newStatus = mapUpsStatus(statusContext)


        return { tn, newStatus, currentStatus: statusContext, latestActivity }
      })
    )

    for (const result of results) {
      if (result.status !== 'fulfilled' || !result.value) continue
      const { tn, newStatus, currentStatus, latestActivity } = result.value
      if (!newStatus) {
        console.warn(`UPS sync: no mapped status for TN ${tn} (desc="${currentStatus?.description}") — skipping`)
        continue
      }

      // Lifecycle rank: never allow a lower-rank status to overwrite a higher-rank one
      const statusRank = { pending: 0, shipped: 1, in_transit: 2, exception: 3, delivered: 4 }

      // Apply to every doc with this tracking number
      for (const shipDoc of (byTracking.get(tn) || [])) {
        const shipment = shipDoc.data()
        if (newStatus === shipment.status) continue
        const currentRank = statusRank[shipment.status] ?? -1
        const newRank = statusRank[newStatus] ?? -1
        if (newRank < currentRank) {
          console.warn(`UPS sync: TN ${tn} — refusing to downgrade ${shipment.status}(${currentRank}) → ${newStatus}(${newRank})`)
          continue
        }
        if (newStatus === 'delivered' && isStaleDelivery(latestActivity?.date, shipment.createdAt)) {
          console.warn(`UPS sync: TN ${tn} — skipping stale delivery (activity date ${latestActivity?.date} predates shipment createdAt), doc=${shipDoc.ref.path}`)
          continue
        }

        const updates = {
          status: newStatus,
          upsStatus: currentStatus?.description || currentStatus?.code || null,
          upsDescription: currentStatus?.description || null,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: 'system:ups-sync',
        }
        if (newStatus === 'delivered') {
          // Use actual carrier event time when available; fall back to server time
          if (latestActivity?.date && latestActivity?.time) {
            const d = latestActivity.date  // YYYYMMDD
            const t = latestActivity.time  // HHMMSS
            updates.deliveredAt = new Date(
              `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}`
            )
          } else {
            updates.deliveredAt = FieldValue.serverTimestamp()
          }
        }
        if (newStatus === 'shipped' && !shipment.shippedAt) {
          updates.shippedAt = FieldValue.serverTimestamp()
        }
        pendingUpdates.push({ ref: shipDoc.ref, updates })
      }
    }

    // Small delay between chunks to avoid rate limiting
    if (i + PARALLEL < uniqueTrackingNumbers.length) {
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  // Batched Firestore writes (max 500 per batch)
  const WRITE_BATCH_SIZE = 500
  for (let w = 0; w < pendingUpdates.length; w += WRITE_BATCH_SIZE) {
    const writeBatch = firestore.batch()
    const slice = pendingUpdates.slice(w, w + WRITE_BATCH_SIZE)
    for (const { ref, updates } of slice) {
      writeBatch.update(ref, updates)
    }
    await writeBatch.commit()
    updated += slice.length
  }

  console.log(`UPS sync for ${orgSlug}: ${updated}/${docsWithTracking.length} docs updated, ${apiCalls} API calls (${uniqueTrackingNumbers.length} unique TNs), ${skippedStale} stale skipped`)
  return { updated, checked: docsWithTracking.length, apiCalls, skippedStale }
}



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

// ─── UPS Track Alert ─────────────────────────────────────────────────────────

/**
 * Public HTTPS endpoint — UPS posts tracking events here when package status changes.
 * No auth middleware: UPS authenticates via the `credential` header we validate internally.
 */
export const upsTrackAlertWebhook = onRequest(
  { secrets: [trackAlertWebhookSecret] },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed')
      return
    }
    await handleTrackAlertWebhook(req, res, firestore, trackAlertWebhookSecret.value())
  }
)

/**
 * Callable — subscribe one or more UPS tracking numbers to Track Alert push notifications.
 * UPS will POST status changes to upsTrackAlertWebhook going forward.
 */
export const subscribeUpsTracking = onCall(
  { secrets: [upsClientId, upsClientSecret, upsMode, trackAlertWebhookSecret] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Must be signed in.')
    const { trackingNumbers } = request.data
    if (!Array.isArray(trackingNumbers) || trackingNumbers.length === 0)
      throw new HttpsError('invalid-argument', 'trackingNumbers array required.')
    if (trackingNumbers.length > 100)
      throw new HttpsError('invalid-argument', 'Max 100 tracking numbers per call.')

    try {
      const token = await getUpsToken(upsClientId.value(), upsClientSecret.value())
      const webhookUrl = `https://us-central1-delivery-manifest-c3deb.cloudfunctions.net/upsTrackAlertWebhook`
      return await subscribeTrackingNumbers(trackingNumbers, webhookUrl, trackAlertWebhookSecret.value(), token)
    } catch (err) {
      console.error('subscribeUpsTracking error:', err)
      throw new HttpsError('internal', err.message || 'Failed to subscribe tracking numbers.')
    }
  }
)

const WEBHOOK_URL = 'https://us-central1-delivery-manifest-c3deb.cloudfunctions.net/upsTrackAlertWebhook'

/**
 * Firestore onCreate trigger — auto-subscribes new UPS shipments to Track Alert.
 * Fires when any shipment document is created under organizations/{orgSlug}/shipments/{shipmentId}.
 * Silently logs errors so a failed subscription never blocks shipment creation.
 */
export const onShipmentCreated = onDocumentCreated(
  {
    document: 'organizations/{orgSlug}/shipments/{shipmentId}',
    secrets: [upsClientId, upsClientSecret, upsMode, trackAlertWebhookSecret],
  },
  async (event) => {
    const data = event.data?.data()
    if (!data) return

    const { trackingNumber, carrier } = data
    if (!trackingNumber || !carrier) return

    const carrierLower = carrier.toLowerCase()
    if (carrierLower !== 'ups') return

    const { orgSlug, shipmentId } = event.params
    console.log(`onShipmentCreated: subscribing TN ${trackingNumber} for org=${orgSlug}, shipment=${shipmentId}`)

    try {
      const token = await getUpsToken(upsClientId.value(), upsClientSecret.value())
      const result = await subscribeTrackingNumbers(
        [trackingNumber],
        WEBHOOK_URL,
        trackAlertWebhookSecret.value(),
        token
      )
      console.log(`onShipmentCreated: subscribed TN ${trackingNumber}`, JSON.stringify(result))
    } catch (err) {
      // Don't throw — subscription failure must not block shipment creation
      console.error(`onShipmentCreated: failed to subscribe TN ${trackingNumber}:`, err.message)
    }
  }
)

/**
 * Callable — backfill Track Alert subscriptions for all active UPS shipments
 * across all organizations. Use once to subscribe existing shipments.
 * Returns { subscribedCount } — the number of unique tracking numbers subscribed.
 */
export const backfillTrackAlertSubscriptions = onCall(
  {
    secrets: [upsClientId, upsClientSecret, upsMode, trackAlertWebhookSecret],
    memory: '512MiB',
    timeoutSeconds: 300,
  },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Must be signed in.')

    const activeStatuses = ['pending', 'shipped', 'in_transit', 'exception']
    const cutoffDate = new Date('2026-05-21T00:00:00Z')

    // Query both lowercase and legacy uppercase carrier values
    const [snapLower, snapUpper] = await Promise.all([
      firestore.collectionGroup('shipments')
        .where('carrier', '==', 'ups')
        .where('status', 'in', activeStatuses)
        .where('createdAt', '>=', cutoffDate)
        .get(),
      firestore.collectionGroup('shipments')
        .where('carrier', '==', 'UPS')
        .where('status', 'in', activeStatuses)
        .where('createdAt', '>=', cutoffDate)
        .get(),
    ])

    const allDocs = [...snapLower.docs, ...snapUpper.docs]
    console.log(`backfillTrackAlertSubscriptions: found ${allDocs.length} active UPS shipment docs (created >= 2026-05-21)`)

    // Dedupe tracking numbers
    const trackingSet = new Set()
    for (const doc of allDocs) {
      const tn = doc.data().trackingNumber?.trim()
      if (tn) trackingSet.add(tn)
    }

    const uniqueTrackingNumbers = [...trackingSet]
    console.log(`backfillTrackAlertSubscriptions: ${uniqueTrackingNumbers.length} unique tracking numbers to subscribe`)

    if (uniqueTrackingNumbers.length === 0) {
      return { subscribedCount: 0 }
    }

    const token = await getUpsToken(upsClientId.value(), upsClientSecret.value())
    const webhookSecret = trackAlertWebhookSecret.value()

    // Subscribe in batches of 100 (UPS Track Alert max per call)
    const BATCH_SIZE = 100
    let subscribedCount = 0

    for (let i = 0; i < uniqueTrackingNumbers.length; i += BATCH_SIZE) {
      const batch = uniqueTrackingNumbers.slice(i, i + BATCH_SIZE)
      try {
        const result = await subscribeTrackingNumbers(batch, WEBHOOK_URL, webhookSecret, token)
        subscribedCount += batch.length
        console.log(`backfillTrackAlertSubscriptions: batch ${Math.floor(i / BATCH_SIZE) + 1} subscribed ${batch.length} TNs`, JSON.stringify(result))
      } catch (err) {
        console.error(`backfillTrackAlertSubscriptions: batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, err.message)
      }
    }

    console.log(`backfillTrackAlertSubscriptions: done — ${subscribedCount}/${uniqueTrackingNumbers.length} tracking numbers subscribed`)
    return { subscribedCount }
  }
)

export { sendSms } from './sms-send.js'
export { ringcentralInbound } from './sms-inbound.js'
export { saveRingCentralCreds } from './sms-save-creds.js'
export { registerRcWebhook, deregisterRcWebhook } from './sms-webhook-register.js'
export { renewRcWebhooks } from './sms-webhook-renew.js'

// --- Usage counters for platform-admin billing ---
// Spec: docs/superpowers/specs/2026-06-11-platform-admin-usage-billing-design.md
// Triggers maintain organizations/{slug}.shipmentCount + monthlyUsage;
// the scheduled job reconciles drift monthly.
export {
  onShipmentCreatedUsage,
  onShipmentDeletedUsage,
} from './usage-counters.js'
export { reconcileUsageMonthly } from './usage-reconcile.js'

// --- Platform-admin callables (super-user dashboard) ---
// Spec: docs/superpowers/specs/2026-06-11-platform-admin-usage-billing-design.md
// Gated server-side by requirePlatformAdmin (lib/admin-guard.js).
export {
  getOrgUsageSummary,
  updateOrgBillingConfig,
} from './admin-usage.js'

// --- Settings remote-assist (super-user dashboard, Option A) ---
// Spec: docs/superpowers/specs/2026-06-11-platform-admin-usage-billing-design.md
// Secrets masked on read, mask markers stripped on write, audited per change.
export {
  getOrgSettings,
  updateOrgSettings,
} from './admin-settings.js'

// --- Invite-link preauth validation (unauthenticated onCall) ---
export { validateInvite } from './validate-invite.js'
