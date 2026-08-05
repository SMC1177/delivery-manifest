// functions/admin-settings.js
// platformAdmin-only settings remote-assist (Option A — no impersonation).
// Spec: docs/superpowers/specs/2026-06-11-platform-admin-usage-billing-design.md
// READ: secrets masked (presence only). WRITE: mask markers stripped so a
// saved masked form can never clobber a stored secret. Every write needs a
// reason and lands in platformAudit with masked before/after.
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { requirePlatformAdmin } from './lib/admin-guard.js'
import { maskSecrets, stripMaskMarkers } from './lib/settings-mask.js'
import { validateTemplatePlaceholders } from './sms-templates.js'

const ORG_EDITABLE_FIELDS = ['settings', 'enabledFields', 'name', 'logo']

export const getOrgSettings = onCall(async (request) => {
  const { uid, email } = await requirePlatformAdmin(request)

  const { orgSlug } = request.data || {}
  if (!orgSlug || typeof orgSlug !== 'string' || orgSlug.includes('/')) {
    throw new HttpsError('invalid-argument', 'orgSlug must be a non-empty string without "/"')
  }

  const firestore = getFirestore()
  const orgRef = firestore.doc(`organizations/${orgSlug}`)
  const orgSnap = await orgRef.get()
  if (!orgSnap.exists) {
    throw new HttpsError('not-found', 'Organization not found')
  }

  const orgData = orgSnap.data()
  const org = {}
  for (const key of ORG_EDITABLE_FIELDS) {
    if (key in orgData) {
      org[key] = orgData[key]
    }
  }

  const settingsDocs = {}
  const settingsSnap = await firestore.collection(`organizations/${orgSlug}/settings`).get()
  for (const doc of settingsSnap.docs) {
    settingsDocs[doc.id] = maskSecrets(doc.data())
  }

  return {
    orgSlug,
    org: maskSecrets(org),
    settingsDocs,
  }
})

export const updateOrgSettings = onCall(async (request) => {
  const { uid, email } = await requirePlatformAdmin(request)

  const { orgSlug, target, updates, reason } = request.data || {}
  if (!orgSlug || typeof orgSlug !== 'string' || orgSlug.includes('/')) {
    throw new HttpsError('invalid-argument', 'orgSlug must be a non-empty string without "/"')
  }
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'reason required')
  }
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new HttpsError('invalid-argument', 'updates must be a plain object')
  }

  let targetRef
  let targetPath
  if (target === 'org') {
    // Only allow keys within ORG_EDITABLE_FIELDS
    for (const key of Object.keys(updates)) {
      if (!ORG_EDITABLE_FIELDS.includes(key)) {
        throw new HttpsError('invalid-argument', `Key "${key}" is not allowed for target "org"`)
      }
    }

    // Templates nest inside `settings`, so the key check above never sees their
    // content. Validate placeholders HERE rather than leaving renderTemplate to
    // throw at send time, which would surface the mistake while texting a patient.
    const incomingTemplates = updates.settings?.templates
    if (incomingTemplates && typeof incomingTemplates === 'object') {
      for (const [templateKey, body] of Object.entries(incomingTemplates)) {
        if (typeof body !== 'string') continue
        try {
          validateTemplatePlaceholders(body)
        } catch (e) {
          // Plain Error -> HttpsError, else the client sees an opaque 'internal'.
          throw new HttpsError('invalid-argument', `Template "${templateKey}": ${e.message}`)
        }
      }
    }
    const firestore = getFirestore()
    targetRef = firestore.doc(`organizations/${orgSlug}`)
    targetPath = `organizations/${orgSlug}`
  } else if (typeof target === 'string' && target.startsWith('settings/')) {
    const docId = target.slice('settings/'.length)
    if (!/^[A-Za-z0-9_-]+$/.test(docId)) {
      throw new HttpsError('invalid-argument', 'Invalid settings docId')
    }
    const firestore = getFirestore()
    targetRef = firestore.doc(`organizations/${orgSlug}/settings/${docId}`)
    targetPath = `organizations/${orgSlug}/settings/${docId}`
  } else {
    throw new HttpsError('invalid-argument', 'target must be "org" or "settings/<docId>"')
  }

  const firestore = getFirestore()
  const orgRef = firestore.doc(`organizations/${orgSlug}`)
  const orgSnap = await orgRef.get()
  if (!orgSnap.exists) {
    throw new HttpsError('not-found', 'Organization not found')
  }

  // Capture before state
  let before
  if (target === 'org') {
    const orgData = orgSnap.data()
    const beforeOrg = {}
    for (const key of ORG_EDITABLE_FIELDS) {
      if (key in orgData) {
        beforeOrg[key] = orgData[key]
      }
    }
    before = maskSecrets(beforeOrg)
  } else {
    const targetSnap = await targetRef.get()
    before = targetSnap.exists ? maskSecrets(targetSnap.data()) : null
  }

  const cleaned = stripMaskMarkers(updates)
  await targetRef.set(cleaned, { merge: true })

  try {
    await firestore.collection('platformAudit').add({
      actor: uid,
      actorEmail: email,
      action: 'settings_update',
      orgSlug,
      target: targetPath,
      reason: reason.trim(),
      before,
      after: maskSecrets(cleaned),
      at: FieldValue.serverTimestamp(),
    })
  } catch (err) {
    console.error('Audit write failed:', err)
    throw new HttpsError('internal', 'audit write failed')
  }

  return { ok: true }
})
