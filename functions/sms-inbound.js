import { onRequest } from 'firebase-functions/v2/https'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { normalizePhone, maskPhone } from './lib/phoneNormalize.js'
import { renderTemplate } from './sms-templates.js'
import { sendRingCentralSms } from './ringcentral-sms.js'
import { getRingCentralCredsForOrg } from './lib/rcCredentials.js'

const OPT_IN_WORDS = new Set(['YES', 'Y', 'START'])
const OPT_OUT_WORDS = new Set(['STOP', 'UNSUBSCRIBE', 'QUIT', 'CANCEL', 'END', 'PARE', 'ARRET', 'ALTO', 'BAJA', 'DETENER', 'PARAR', 'NO'])

function classifyBody(body) {
  if (typeof body !== 'string') return 'non_keyword'
  const word = body.trim().toUpperCase()
  if (OPT_IN_WORDS.has(word)) return 'opt_in'
  if (OPT_OUT_WORDS.has(word)) return 'opt_out'
  return 'non_keyword'
}

export const ringcentralInbound = onRequest(async (req, res) => {
  // RC webhook validation handshake
  const validationToken = req.headers?.['validation-token'] || req.get?.('validation-token')
  if (validationToken) {
    res.set('Validation-Token', validationToken)
    res.status(200).send('OK')
    return
  }

  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed')
    return
  }

  const orgSlug = req.query.org
  if (!orgSlug || typeof orgSlug !== 'string') {
    res.status(400).send('Missing ?org param')
    return
  }

  const firestore = getFirestore()
  const settingsSnap = await firestore.doc(`organizations/${orgSlug}/settings/textMessaging`).get()
  if (!settingsSnap.exists) {
    res.status(404).send('Org has no text messaging configured')
    return
  }
  const settings = settingsSnap.data()

  const token = req.get('x-webhook-token') || req.query.t
  if (!token || token !== settings.webhookToken) {
    res.status(401).send('Unauthorized')
    return
  }

  if (!settings.enabled) {
    res.status(200).send('Messaging disabled') // 200 so RC stops retrying
    return
  }

  const body = req.body || {}
  const messageId = body.body?.messageId || body.messageId || body.id
  const from = body.body?.from?.phoneNumber || body.from?.phoneNumber || body.from
  const text = body.body?.subject || body.body?.text || body.text || ''

  if (!from) {
    res.status(200).send('No sender')
    return
  }

  // Dedupe by messageId
  if (messageId) {
    const dedupeRef = firestore.doc(`organizations/${orgSlug}/settings/textMessaging/inboundSeen/${messageId}`)
    const seen = await dedupeRef.get()
    if (seen.exists) {
      res.status(200).send('Duplicate')
      return
    }
    await dedupeRef.set({ seenAt: FieldValue.serverTimestamp() })
  }

  let phone
  try {
    phone = normalizePhone(from)
  } catch {
    res.status(200).send('Invalid sender phone, ignored')
    return
  }

  const classification = classifyBody(text)
  const contactRef = firestore.doc(`organizations/${orgSlug}/smsContacts/${phone}`)
  const auditRef = firestore.collection(`organizations/${orgSlug}/auditLog`)

  if (classification === 'non_keyword') {
    await auditRef.add({
      action: 'sms.non_keyword_inbound',
      targetId: maskPhone(phone),
      details: {}, // intentionally no body — PHI safety
      timestamp: FieldValue.serverTimestamp(),
    })
    if (settings.autoReplyToNonKeyword && settings.templates?.nonKeywordRedirect) {
      let autoReplyCreds
      try {
        autoReplyCreds = await getRingCentralCredsForOrg(orgSlug)
      } catch (e) {
        console.error('Auto-reply skipped — could not load RC creds:', e.message)
        // skip the auto-reply for this path; do not throw — the inbound handler must still 200 to RC
        // continue to next logic block as if auto-reply were disabled
      }
      if (autoReplyCreds) {
        try {
          const orgSnap = await firestore.doc(`organizations/${orgSlug}`).get()
          const org = orgSnap.data() || {}
          const replyText = renderTemplate(settings.templates.nonKeywordRedirect, {
            pharmacyName: org.name || orgSlug,
            pharmacyPhone: org.contactPhone || '',
          })
          await sendRingCentralSms({
            creds: autoReplyCreds,
            from: autoReplyCreds.fromNumber,
            to: phone,
            text: replyText,
          })
          await auditRef.add({
            action: 'sms.auto_reply_sent',
            targetId: maskPhone(phone),
            details: { reason: 'non_keyword' },
            timestamp: FieldValue.serverTimestamp(),
          })
        } catch (e) {
          // Auto-reply failure is non-fatal — still 200 the webhook
          console.error('Auto-reply (non_keyword) failed:', e.message)
        }
      }
    }
    res.status(200).send('OK')
    return
  }

  // Match — update contact + audit
  const optIn = classification === 'opt_in'
  await contactRef.set(
    {
      phone,
      optIn,
      respondedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )
  await auditRef.add({
    action: 'sms.invite_response',
    targetId: maskPhone(phone),
    details: { reply: optIn ? 'YES' : 'STOP' },
    timestamp: FieldValue.serverTimestamp(),
  })

  // Optional auto-confirm
  if (settings.autoReplyOnYesStop) {
    const templateKey = optIn ? 'optInConfirm' : 'optOutConfirm'
    const template = settings.templates?.[templateKey]
    if (template) {
      let autoReplyCreds
      try {
        autoReplyCreds = await getRingCentralCredsForOrg(orgSlug)
      } catch (e) {
        console.error('Auto-reply skipped — could not load RC creds:', e.message)
        // skip the auto-reply for this path; do not throw — the inbound handler must still 200 to RC
        // continue to next logic block as if auto-reply were disabled
      }
      if (autoReplyCreds) {
        try {
          const orgSnap = await firestore.doc(`organizations/${orgSlug}`).get()
          const org = orgSnap.data() || {}
          const replyText = renderTemplate(template, {
            pharmacyName: org.name || orgSlug,
            pharmacyPhone: org.contactPhone || '',
          })
          await sendRingCentralSms({
            creds: autoReplyCreds,
            from: autoReplyCreds.fromNumber,
            to: phone,
            text: replyText,
          })
          await auditRef.add({
            action: 'sms.auto_reply_sent',
            targetId: maskPhone(phone),
            details: { reason: optIn ? 'opt_in_confirm' : 'opt_out_confirm' },
            timestamp: FieldValue.serverTimestamp(),
          })
        } catch (e) {
          console.error('Auto-reply (yes/stop) failed:', e.message)
        }
      }
    }
  }

  res.status(200).send('OK')
})
