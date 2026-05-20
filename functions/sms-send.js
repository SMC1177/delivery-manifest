import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { normalizePhone, maskPhone } from './lib/phoneNormalize.js'
import { renderTemplate, validateOptInInvite } from './sms-templates.js'
import { checkAndIncrementRateLimit } from './sms-rate-limit.js'
import { checkSendPreconditions, checkOptInPolicy, GATE_ERRORS, userMessageFor } from './sms-gates.js'
import { sendRingCentralSms } from './ringcentral-sms.js'

export const sendSms = onCall(async (request) => {
  const firestore = getFirestore()
  const { orgSlug, shipmentId, templateKey, consentAffirmed = false } = request.data || {}

  if (!orgSlug || !shipmentId || !templateKey) {
    throw new HttpsError('invalid-argument', 'orgSlug, shipmentId, templateKey are required')
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

  // Normalize phone
  let phone
  try {
    phone = normalizePhone(shipment.phone)
  } catch (e) {
    throw new HttpsError('invalid-argument', `Phone number is invalid: ${e.message}`)
  }

  // Load contact (may not exist yet)
  const contactRef = firestore.doc(`organizations/${orgSlug}/smsContacts/${phone}`)
  const contactSnap = await contactRef.get()
  const contact = contactSnap.exists ? contactSnap.data() : null

  // Opt-in policy
  const policy = checkOptInPolicy({
    settings,
    contact,
    templateKey,
    consentAffirmed,
  })
  if (!policy.ok) {
    throw new HttpsError('failed-precondition', userMessageFor(policy.code), { code: policy.code })
  }

  // Resolve template body
  const template = settings.templates?.[templateKey]
  if (!template) {
    throw new HttpsError('failed-precondition', `Unknown template: ${templateKey}`)
  }
  if (templateKey === 'optInInvite') {
    try { validateOptInInvite(template) }
    catch (e) { throw new HttpsError('failed-precondition', e.message) }
  }

  // Render
  let body
  try {
    body = renderTemplate(template, {
      pharmacyName: org.name || orgSlug,
      patientName: shipment.patientName || '',
      pharmacyPhone: org.contactPhone || '',
    })
  } catch (e) {
    throw new HttpsError('failed-precondition', e.message)
  }

  // Rate limit (atomic increment — only consumes a slot if it sends)
  const cap = settings.dailyCap || 250
  const limit = await checkAndIncrementRateLimit({ firestore, orgSlug, cap })
  if (!limit.allowed) {
    await firestore.collection(`organizations/${orgSlug}/auditLog`).add({
      action: 'sms.rate_limit_hit',
      targetId: orgSlug,
      details: { daily: limit.current, cap: limit.cap },
      userId: request.auth.uid,
      timestamp: FieldValue.serverTimestamp(),
    })
    throw new HttpsError('resource-exhausted', userMessageFor(GATE_ERRORS.RATE_LIMITED))
  }

  // SEND
  let messageId
  try {
    const result = await sendRingCentralSms({
      creds: settings.ringcentral,
      from: settings.ringcentral.fromNumber,
      to: phone,
      text: body,
    })
    messageId = result.messageId
  } catch (e) {
    await contactRef.set(
      { phone, lastError: e.message, lastErrorAt: FieldValue.serverTimestamp() },
      { merge: true },
    )
    await firestore.collection(`organizations/${orgSlug}/auditLog`).add({
      action: 'sms.send_failed',
      targetId: maskPhone(phone),
      details: { shipmentId, templateKey, error: e.message },
      userId: request.auth.uid,
      timestamp: FieldValue.serverTimestamp(),
    })
    throw new HttpsError('internal', e.message)
  }

  // Update contact
  const contactUpdate = {
    phone,
    patientName: shipment.patientName || contact?.patientName || null,
    lastContactedAt: FieldValue.serverTimestamp(),
    totalSent: FieldValue.increment(1),
    lastError: null,
  }
  if (templateKey === 'optInInvite') {
    contactUpdate.invitedAt = FieldValue.serverTimestamp()
    if (!contact) contactUpdate.optIn = null
  } else if (policy.autoCreateOptedIn) {
    contactUpdate.optIn = true
    contactUpdate.respondedAt = FieldValue.serverTimestamp()
  }
  await contactRef.set(contactUpdate, { merge: true })

  // Audit log
  const action = templateKey === 'optInInvite' ? 'sms.invite_sent' : 'sms.message_sent'
  await firestore.collection(`organizations/${orgSlug}/auditLog`).add({
    action,
    targetId: maskPhone(phone),
    details: { shipmentId, templateKey, templateBody: body, ringcentralMessageId: messageId },
    userId: request.auth.uid,
    timestamp: FieldValue.serverTimestamp(),
  })

  return { ok: true, messageId }
})
