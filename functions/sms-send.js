import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { normalizePhone } from './lib/phoneNormalize.js'
import { checkSendPreconditions, checkOptInPolicy, userMessageFor } from './sms-gates.js'
import { enqueue } from './lib/smsQueue.js'

// The operator's rule: a delivered shipment must never trigger a text.
// This is a server-side BACKSTOP, not a mirror of the frontend's SENDABLE_TEMPLATE_KEYS.
// If this guard ever fires, the frontend re-enabled a forbidden template — fix it there,
// do not weaken this. The automated status trigger does not pass through this callable.
export const NEVER_MANUALLY_SENDABLE = ['delivered']

export const sendSms = onCall(async (request) => {
  const firestore = getFirestore()
  const { orgSlug, shipmentId, templateKey, consentAffirmed = false } = request.data || {}

  if (!orgSlug || !shipmentId || !templateKey) {
    throw new HttpsError('invalid-argument', 'orgSlug, shipmentId, templateKey are required')
  }

  if (NEVER_MANUALLY_SENDABLE.includes(templateKey)) {
    throw new HttpsError(
      'failed-precondition',
      `"${templateKey}" is never manually sendable — a delivered shipment must not trigger a text. ` +
      `If you are seeing this, the frontend re-enabled it; fix the source, not this guard.`,
    )
  }

  // Load org, settings, member, shipment in parallel
  const [orgSnap, settingsSnap, memberSnap, shipmentSnap] = await Promise.all([
    firestore.doc(`organizations/${orgSlug}`).get(),
    firestore.doc(`organizations/${orgSlug}/settings/textMessaging`).get(),
    request.auth ? firestore.doc(`organizations/${orgSlug}/members/${request.auth.uid}`).get() : Promise.resolve(null),
    firestore.doc(`organizations/${orgSlug}/shipments/${shipmentId}`).get(),
  ])

  const org = orgSnap.exists ? orgSnap.data() : null
  const settings = settingsSnap.exists ? settingsSnap.data() : null
  const memberRole = memberSnap?.exists ? memberSnap.data().role : null
  const shipment = shipmentSnap.exists ? shipmentSnap.data() : null

  // Preconditions
  const pre = checkSendPreconditions({
    auth: request.auth,
    memberRole,
    settings,
    org,
    shipment,
  })
  if (!pre.ok) {
    throw new HttpsError('failed-precondition', userMessageFor(pre.code), { code: pre.code })
  }

  // No direct-send path: every text is queued, and the queue is keyed by the
  // shipment's tracking number, so the ledger claim (which lives inside
  // enqueue) is what makes a repeat request a no-op.
  const trackingNumber = shipment.trackingNumber
  if (!trackingNumber || String(trackingNumber).trim() === '') {
    throw new HttpsError('invalid-argument', 'cannot queue a text for a shipment without a tracking number')
  }

  // Normalize phone (the opt-in contact is keyed by the normalized number)
  let phone
  try {
    phone = normalizePhone(shipment.phone)
  } catch (e) {
    throw new HttpsError('invalid-argument', `Phone number is invalid: ${e.message}`)
  }

  // Load contact (may not exist yet). FAIL-OPEN ruling (2026-08-16): if the
  // consent READ itself fails (timeout/indeterminate), assume opt-in rather than
  // suppressing a transactional delivery notice — and log it so a message sent on
  // real consent is distinguishable from one sent because a read timed out.
  // The catch covers ONLY this read — never checkOptInPolicy or the gate section.
  let contact
  try {
    const contactRef = firestore.doc(`organizations/${orgSlug}/smsContacts/${phone}`)
    const contactSnap = await contactRef.get()
    contact = contactSnap.exists ? contactSnap.data() : null
  } catch (err) {
    console.warn(`[sms] consent read failed for org "${orgSlug}" phone "${phone}" — assuming opt-in: ${err && err.message ? err.message : err}`)
    contact = { optIn: true }
  }

  // Opt-in policy (fast-fail at the button; the drain re-checks at send time)
  const policy = checkOptInPolicy({
    settings,
    contact,
    templateKey,
    consentAffirmed,
    orgSlug,
  })
  if (!policy.ok) {
    throw new HttpsError('failed-precondition', userMessageFor(policy.code), { code: policy.code })
  }

  // Claim and enqueue. The ledger claim lives inside enqueue(); the drain owns
  // the daily cap, the template render, the provider call, and the send-side
  // contact bookkeeping.
  let outcome
  try {
    outcome = await enqueue({
      firestore,
      orgSlug,
      trackingNumber,
      templateKey,
      shipmentIds: [shipmentId],
      now: new Date(),
    })
  } catch (e) {
    await firestore.collection(`organizations/${orgSlug}/auditLog`).add({
      action: 'sms.enqueue_failed',
      targetId: orgSlug,
      details: { shipmentId, templateKey, trackingNumber, error: e.message },
      userId: request.auth.uid,
      timestamp: FieldValue.serverTimestamp(),
    })
    console.error('sendSms: enqueue failed', { orgSlug, templateKey, trackingNumber, error: e.message })
    throw new HttpsError('internal', e.message)
  }

  if (!outcome.enqueued) {
    return { ok: true, status: 'already_notified', trackingNumber }
  }

  // Audit the request at enqueue time; the send-completion audit and contact
  // updates are the drain's job once the message actually goes out.
  const action = templateKey === 'optInInvite' ? 'sms.invite_queued' : 'sms.message_queued'
  await firestore.collection(`organizations/${orgSlug}/auditLog`).add({
    action,
    targetId: orgSlug,
    details: { shipmentId, templateKey, trackingNumber },
    userId: request.auth.uid,
    timestamp: FieldValue.serverTimestamp(),
  })

  return { ok: true, status: 'queued', trackingNumber }
})
