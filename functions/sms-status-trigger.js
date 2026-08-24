import { enqueue } from './lib/smsQueue.js'

/**
 * Which shipment statuses notify the patient, and which template each uses.
 *
 * This map is POLICY, deliberately kept as data rather than logic: the final
 * set is the w0-1 decision and belongs to the operator, not to this file. The
 * tests assert the MECHANISM — a status in the map enqueues exactly once, a
 * status outside it enqueues nothing — so changing the membership here does
 * not require touching a single test.
 *
 * The keys are STATUS names and the values are TEMPLATE names — two different
 * vocabularies that happen to share some spellings. A status is not a template:
 * 'shipped' maps to the 'outForDelivery' template, 'exception' to the
 * 'addressIssue' template.
 *
 * 'delivered', 'pending' and 'archived' are absent on purpose. Pending is the state a row
 * is created in, and archived only means the row was filed; neither is a
 * delivery event the patient should hear about.
 */
export const STATUS_TEMPLATE_KEYS = {
  shipped: 'outForDelivery',
  exception: 'addressIssue',
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The 7-day recency gate on the pharmacy's OWN date (operator rule; seat seq
 * 1397). The pharmacy date survives a wipe-and-reimport unchanged — createdAt
 * does not — so backlogs and reimports stay silent. Fail-safe follows the
 * smsLedger convention: an absent or unparseable date REFUSES, because refusing
 * a send is recoverable and texting a stale row is not.
 */
export function isRecentDate(date, now = new Date()) {
  if (!date || typeof date !== 'string') return false
  const parsed = Date.parse(date)
  if (Number.isNaN(parsed)) return false
  const age = now.getTime() - parsed
  return age >= -SEVEN_DAYS_MS && age <= SEVEN_DAYS_MS
}

const trackingOf = (doc) => (doc && doc.trackingNumber ? String(doc.trackingNumber).trim() : '')

/**
 * Firestore onUpdate handler for a shipment.
 *
 * It ENQUEUES and never sends. Pacing, batching, the daily cap and the
 * idempotency ledger all live downstream in the drain, so an over-eager
 * trigger is harmless: the queue keys one document per (tracking, template),
 * and a repeat merely merges.
 *
 * Two things make it fire, not one. A status change is the obvious case. The
 * other is a row that GAINS its tracking number on a later import — the
 * operator's rule is that a tracked row gets the pending message, and until
 * the tracking number arrives there is nothing to key that message on.
 *
 * A row with no tracking number returns silently rather than throwing;
 * throwing here would make Firestore retry the trigger forever.
 */
export async function onShipmentStatusChange({
  firestore,
  before,
  after,
  orgSlug,
  shipmentId,
  now = new Date(),
}) {
  // Initial text: the FIRST text of the lifecycle. A pending row that GAINS its
  // tracking number gets the trackingAssigned message — once per tracking via
  // the enqueue-time ledger, and only when the pharmacy date is recent (the
  // mass-text gate: a wipe-reimport resets every row to pending, so ungated
  // this would text every patient in the backlog).
  if (after && after.status === 'pending') {
    const pendingTracking = trackingOf(after)
    const pendingArrived = trackingOf(before) === '' && pendingTracking !== ''
    if (pendingTracking && pendingArrived && isRecentDate(after.date, now)) {
      await enqueue({
        firestore,
        orgSlug,
        trackingNumber: pendingTracking,
        templateKey: 'trackingAssigned',
        shipmentIds: shipmentId ? [shipmentId] : [],
        now,
      })
      return { enqueued: true, templateKey: 'trackingAssigned', trackingNumber: pendingTracking }
    }
    return { enqueued: false, reason: 'pending_not_notifiable' }
  }

  const templateKey = STATUS_TEMPLATE_KEYS[after && after.status]
  if (!templateKey) return { enqueued: false, reason: 'status_not_notifying' }

  const tracking = trackingOf(after)
  if (!tracking) return { enqueued: false, reason: 'no_tracking_number' }

  const statusChanged = !before || before.status !== after.status
  const trackingArrived = trackingOf(before) === '' && tracking !== ''
  if (!statusChanged && !trackingArrived) {
    return { enqueued: false, reason: 'nothing_notifiable_changed' }
  }

  await enqueue({
    firestore,
    orgSlug,
    trackingNumber: tracking,
    templateKey,
    shipmentIds: shipmentId ? [shipmentId] : [],
    now,
  })

  return { enqueued: true, templateKey, trackingNumber: tracking }
}

/**
 * Create-path twin of the pending branch: a row BORN with a tracking number in
 * status pending (an import whose spreadsheet already carries tracking) gets
 * the same initial text under the same gates. onDocumentUpdated never fires
 * for creates, so this is wired into the shipment onDocumentCreated trigger.
 */
export async function onShipmentCreatedInitialSms({
  firestore,
  doc,
  orgSlug,
  shipmentId,
  now = new Date(),
}) {
  if (!doc || doc.status !== 'pending') return { enqueued: false, reason: 'status_not_initial' }
  const tracking = trackingOf(doc)
  if (!tracking) return { enqueued: false, reason: 'no_tracking_number' }
  if (!isRecentDate(doc.date, now)) return { enqueued: false, reason: 'date_not_recent' }
  await enqueue({
    firestore,
    orgSlug,
    trackingNumber: tracking,
    templateKey: 'trackingAssigned',
    shipmentIds: shipmentId ? [shipmentId] : [],
    now,
  })
  return { enqueued: true, templateKey: 'trackingAssigned', trackingNumber: tracking }
}
