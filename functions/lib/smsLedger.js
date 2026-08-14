/**
 * SMS idempotency ledger.
 *
 * One document per (tracking number, template) claim, held under the org, so a
 * given delivery is notified exactly once per template within a retention
 * window. Keyed on the TRACKING NUMBER rather than the shipment id: one box is
 * one text however many prescriptions it holds.
 *
 * Shape mirrors functions/sms-rate-limit.js - firestore is injected, and the
 * check and the write share one transaction so two concurrent senders cannot
 * both observe "not yet sent".
 */

const SEP = '__'
const DEFAULT_RETENTION_DAYS = 90
const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Identity fields are required. A silent default would collide unrelated callers onto one claim. */
export function requireField(value, name, context = 'claimSend') {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`${context}: ${name} is required`)
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error(
      `${context}: ${name} arrived as a number too large to represent exactly (${value}); pass it as a string`
    )
  }
  return String(value).trim()
}

/** One path segment. Tracking numbers are lowercased because UPS numbers are alphanumeric. */
export function ledgerKey(trackingNumber, templateKey) {
  const tracking = requireField(trackingNumber, 'trackingNumber').toLowerCase()
  const template = requireField(templateKey, 'templateKey')
  return `${tracking}${SEP}${template}`
}

export function ledgerPath(orgSlug, trackingNumber, templateKey) {
  const org = requireField(orgSlug, 'orgSlug')
  return `organizations/${org}/settings/textMessaging/ledger/${ledgerKey(trackingNumber, templateKey)}`
}

/**
 * Atomically claim the right to send one message for this tracking number and
 * template. Returns { claimed: true } once per key per retention window; an
 * expired claim is treated as absent and may be re-claimed.
 */
export async function claimSend({
  firestore,
  orgSlug,
  trackingNumber,
  templateKey,
  now = new Date(),
  retentionDays = DEFAULT_RETENTION_DAYS,
}) {
  const org = requireField(orgSlug, 'orgSlug')
  const tracking = requireField(trackingNumber, 'trackingNumber')
  const template = requireField(templateKey, 'templateKey')

  const ref = firestore.doc(ledgerPath(org, tracking, template))
  const nowMs = now.getTime()

  return await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (snap.exists) {
      const data = typeof snap.data === 'function' ? snap.data() : null
      const expiresAt = data && data.expiresAt ? Date.parse(data.expiresAt) : null
      // A malformed or absent expiry is treated as unexpired: refusing a send is
      // recoverable, sending twice is not.
      if (expiresAt === null || Number.isNaN(expiresAt) || expiresAt > nowMs) {
        return { claimed: false }
      }
    }
    tx.set(ref, {
      trackingNumber: tracking.toLowerCase(),
      templateKey: template,
      claimedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + retentionDays * MS_PER_DAY).toISOString(),
    })
    return { claimed: true }
  })
}
