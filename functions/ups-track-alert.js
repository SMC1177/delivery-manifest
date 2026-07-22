import { FieldValue } from 'firebase-admin/firestore'
import { isStaleDelivery } from './ups-status.js'

// Lifecycle rank: higher rank wins — never downgrade
const STATUS_RANK = {
  pending: 0,
  shipped: 1,
  in_transit: 2,
  exception: 3,
  delivered: 4,
}

/**
 * Map UPS Track Alert activityStatus.type to our internal status values.
 * See UPS Track Alert API docs for full type list.
 */
function mapTrackAlertStatus(type) {
  if (!type) return null
  switch (type.toUpperCase()) {
    case 'D':   return 'delivered'
    case 'I':   return 'in_transit'
    case 'X':   return 'exception'
    case 'M':   return 'shipped'
    case 'MV':  return 'exception'
    case 'RS':  return 'exception'
    default:    return null
  }
}

/**
 * Parse a UPS date+time pair (YYYYMMDD + HHMMSS) into a JS Date.
 * Returns null if either part is missing or malformed.
 */
function parseUpsDateTime(date, time) {
  if (!date || !time || date.length < 8 || time.length < 6) return null
  try {
    const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`
    const d = new Date(iso)
    return isNaN(d.getTime()) ? null : d
  } catch {
    return null
  }
}

/**
 * Handle UPS Track Alert POST webhook callbacks.
 *
 * UPS sends delivery events here when status changes occur. We validate the
 * credential header, map the status, and update all matching shipments in
 * Firestore using a collection group query so we don't need to know the org.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('firebase-admin/firestore').Firestore} firestore
 * @param {string} webhookSecret - the expected credential value
 */
export async function handleTrackAlertWebhook(req, res, firestore, webhookSecret) {
  // 1. Validate credential header
  const credential = req.headers['credential']
  if (!credential || credential !== webhookSecret) {
    console.warn(`UPS Track Alert: invalid credential header (got: ${credential ? '[present but wrong]' : '[missing]'})`)
    res.status(401).send('Unauthorized')
    return
  }

  const body = req.body
  const trackingNumber = body?.trackingNumber
  const statusType = body?.activityStatus?.type
  const statusDescription = body?.activityStatus?.description || statusType || null

  console.log(`UPS Track Alert: received event for TN=${trackingNumber}, type=${statusType}, desc=${statusDescription}`)

  if (!trackingNumber) {
    console.warn('UPS Track Alert: missing trackingNumber in payload')
    res.status(200).send('OK') // Still 200 — don't ask UPS to retry a bad payload
    return
  }

  const newStatus = mapTrackAlertStatus(statusType)
  if (!newStatus) {
    console.warn(`UPS Track Alert: unknown status type "${statusType}" for TN=${trackingNumber} — ignoring`)
    res.status(200).send('OK')
    return
  }

  // 2. Collection group query across all orgs' shipments
  let snap
  try {
    snap = await firestore
      .collectionGroup('shipments')
      .where('trackingNumber', '==', trackingNumber.trim())
      .get()
  } catch (err) {
    console.error(`UPS Track Alert: Firestore query failed for TN=${trackingNumber}:`, err)
    res.status(200).send('OK') // Still 200 — UPS should not retry indefinitely on our DB errors
    return
  }

  if (snap.empty) {
    console.log(`UPS Track Alert: no shipments found for TN=${trackingNumber}`)
    res.status(200).send('OK')
    return
  }

  // 3. Build updates with lifecycle rank guard
  const newRank = STATUS_RANK[newStatus] ?? -1
  const pendingUpdates = []

  for (const doc of snap.docs) {
    const shipment = doc.data()
    const currentRank = STATUS_RANK[shipment.status] ?? -1

    if (newRank < currentRank) {
      console.warn(
        `UPS Track Alert: TN=${trackingNumber} — refusing to downgrade ${shipment.status}(${currentRank}) → ${newStatus}(${newRank}) for doc ${doc.ref.path}`
      )
      continue
    }

    if (newStatus === shipment.status) {
      console.log(`UPS Track Alert: TN=${trackingNumber} already at ${newStatus} for doc ${doc.ref.path} — skipping`)
      continue
    }

    // 4. Stale-delivery guard: skip if delivery date predates shipment creation
    if (newStatus === 'delivered' && isStaleDelivery(body.actualDeliveryDate, shipment.createdAt)) {
      console.warn(
        `UPS Track Alert: TN=${trackingNumber} — stale delivery (actualDeliveryDate=${body.actualDeliveryDate}) predates createdAt for doc ${doc.ref.path}; skipping`
      )
      continue
    }

    const updates = {
      status: newStatus,
      upsStatus: statusDescription,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: 'system:ups-track-alert',
    }

    // 5. Set deliveredAt from actual delivery fields when available
    if (newStatus === 'delivered') {
      const deliveredAt = parseUpsDateTime(body.actualDeliveryDate, body.actualDeliveryTime)
      updates.deliveredAt = deliveredAt ?? FieldValue.serverTimestamp()
    }

    pendingUpdates.push({ ref: doc.ref, updates })
  }

  // 6. Apply Firestore writes in a batch
  if (pendingUpdates.length > 0) {
    const WRITE_BATCH_SIZE = 500
    for (let i = 0; i < pendingUpdates.length; i += WRITE_BATCH_SIZE) {
      const writeBatch = firestore.batch()
      const slice = pendingUpdates.slice(i, i + WRITE_BATCH_SIZE)
      for (const { ref, updates } of slice) {
        writeBatch.update(ref, updates)
      }
      await writeBatch.commit()
    }
    console.log(`UPS Track Alert: updated ${pendingUpdates.length} shipment(s) for TN=${trackingNumber} → ${newStatus}`)
  } else {
    console.log(`UPS Track Alert: no updates needed for TN=${trackingNumber} (all guarded or same status)`)
  }

  // 7. Return 200 quickly — UPS expects a fast response
  res.status(200).send('OK')
}

/**
 * Subscribe tracking numbers to UPS Track Alert push notifications.
 *
 * UPS will POST to webhookUrl whenever status changes for these packages.
 * The webhookSecret is sent as the "credential" header on each POST so we
 * can verify authenticity in handleTrackAlertWebhook.
 *
 * @param {string[]} trackingNumbers - up to 100 tracking numbers
 * @param {string} webhookUrl - public HTTPS URL for our webhook endpoint
 * @param {string} webhookSecret - auth token UPS will include in the credential header
 * @param {string} token - UPS OAuth2 bearer token
 * @returns {Promise<object>} UPS API response body
 */
export async function subscribeTrackingNumbers(trackingNumbers, webhookUrl, webhookSecret, token) {
  const url = 'https://onlinetools.ups.com/api/track/v1/subscription/standard/package'

  const body = {
    locale: 'en_US',
    trackingNumberList: trackingNumbers,
    destination: {
      url: webhookUrl,
      credentialType: 'Bearer',
      credential: webhookSecret,
    },
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      transId: `track-alert-${Date.now()}`,
      transactionSrc: 'delivery_manifest',
    },
    body: JSON.stringify(body),
  })

  const responseText = await res.text()
  let responseData
  try {
    responseData = JSON.parse(responseText)
  } catch {
    responseData = { raw: responseText }
  }

  if (!res.ok) {
    console.error(`UPS Track Alert subscribe failed (${res.status}):`, responseText)
    throw new Error(`UPS Track Alert subscribe failed (${res.status}): ${responseText}`)
  }

  console.log(`UPS Track Alert: subscribed ${trackingNumbers.length} tracking number(s)`)
  return responseData
}
