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
 * 'pending' and 'archived' are absent on purpose. Pending is the state a row
 * is created in, and archived only means the row was filed; neither is a
 * delivery event the patient should hear about.
 */
export const STATUS_TEMPLATE_KEYS = {
  shipped: 'shipped',
  delivered: 'delivered',
  exception: 'exception',
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
 * A row with no tracking number returns silently rather than throwing. Its
 * message is the "in progress" one, which is keyed on patient identity and is
 * not built yet; throwing here would make Firestore retry the trigger forever.
 */
export async function onShipmentStatusChange({
  firestore,
  before,
  after,
  orgSlug,
  shipmentId,
  now = new Date(),
}) {
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
