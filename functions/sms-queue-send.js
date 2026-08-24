// functions/sms-queue-send.js
//
// The sendMessage the drain expects. It composes exactly what sms-send.js composes —
// the same org gate, the same opt-in policy, the same template render, the same
// RingCentral client — for a queue item instead of a button press. There is
// deliberately no second definition of "may this org text this shipment": drift on
// this path means texting a patient who should not have been texted, with nobody
// watching.
//
// What it does NOT do, on purpose:
//   - claim the ledger: enqueue already claimed it, and a second claim deadlocks.
//   - check the daily cap: sms-queue-drain.js owns the cap and the release-on-cap path.
//   - catch provider errors: it throws, and the drain's fail() decides backoff or
//     dead-letter. A silent success here would drop a real message.
import { normalizePhone } from './lib/phoneNormalize.js'
import { renderTemplate, resolveTemplate } from './sms-templates.js'
import { checkOrgMayText, checkOptInPolicy } from './sms-gates.js'
import { buildBatchedVars } from './lib/smsBatching.js'
import { sendRingCentralSms } from './ringcentral-sms.js'
import { trackingUrlFor, carrierLabel } from './carrier-detection.js'
import { getRingCentralCredsForOrg } from './lib/rcCredentials.js'

function refuse(reason) {
  return new Error(`sms-queue-send: ${reason}`)
}

export async function sendQueuedMessage({ firestore, orgSlug, item }) {
  const shipmentIds = Array.isArray(item?.shipmentIds) ? item.shipmentIds : []
  if (shipmentIds.length === 0) {
    throw refuse('queue item names no shipments, so there is nobody to address')
  }

  const [orgSnap, settingsSnap, ...shipmentSnaps] = await Promise.all([
    firestore.doc(`organizations/${orgSlug}`).get(),
    firestore.doc(`organizations/${orgSlug}/settings/textMessaging`).get(),
    ...shipmentIds.map((id) => firestore.doc(`organizations/${orgSlug}/shipments/${id}`).get()),
  ])

  const org = orgSnap.exists ? orgSnap.data() : null
  const settings = settingsSnap.exists ? settingsSnap.data() : null
  const shipments = shipmentSnaps.filter((s) => s.exists).map((s) => s.data())
  if (shipments.length === 0) {
    throw refuse(`none of the named shipment documents exist: ${shipmentIds.join(', ')}`)
  }

  // ONE BOX, ONE RECIPIENT. If the batched shipments disagree on the phone number,
  // guessing would text one patient about another patient's delivery.
  const phones = [...new Set(shipments.map((s) => normalizePhone(s.phone)))]
  if (phones.length > 1) {
    throw refuse('batched shipments disagree on phone number; refusing to guess a recipient')
  }
  const phone = phones[0]

  // The SAME gate the manual button applies, not a copy of it.
  const gate = checkOrgMayText({ settings, org, shipment: shipments[0] })
  if (!gate.ok) throw refuse(gate.code)

  // FAIL-OPEN ruling (2026-08-16): a consent READ failure (timeout) assumes
  // opt-in — the catch covers ONLY this read, never the gate; log it so real
  // consent is distinguishable from a timed-out read.
  let contact
  try {
    const contactSnap = await firestore.doc(`organizations/${orgSlug}/smsContacts/${phone}`).get()
    contact = contactSnap.exists ? contactSnap.data() : null
  } catch (err) {
    console.warn(`[sms] consent read failed for org "${orgSlug}" phone "${phone}" — assuming opt-in: ${err && err.message ? err.message : err}`)
    contact = { optIn: true }
  }

  // consentAffirmed is false and stays false: under manual_confirm a human must affirm
  // consent, and there is no human in a scheduled drain to do it.
  const policy = checkOptInPolicy({
    settings,
    contact,
    templateKey: item.templateKey,
    consentAffirmed: false,
    orgSlug,
  })
  if (!policy.ok) throw refuse(policy.code)

  const template = resolveTemplate({
    language: settings?.language,
    templateKey: item.templateKey,
    settings,
    patientLanguage: contact?.language,
  })

  const body = renderTemplate(
    template,
    buildBatchedVars({
      item,
      pharmacyName: org?.name || orgSlug,
      patientName: shipments[0].patientName,
      pharmacyPhone: org?.contactPhone,
      trackingUrl: trackingUrlFor(item.trackingNumber),
      trackingNumber: String(item.trackingNumber || '').trim(),
      carrier: carrierLabel(item.trackingNumber),
    })
  )

  const creds = await getRingCentralCredsForOrg(orgSlug)
  const result = await sendRingCentralSms({
    creds,
    from: creds.fromNumber,
    to: phone,
    text: body,
  })

  return {
    phone,
    body,
    messageId: result?.id || null,
    shipmentCount: shipments.length,
  }
}
