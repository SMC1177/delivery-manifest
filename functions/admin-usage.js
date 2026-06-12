// functions/admin-usage.js
// platformAdmin-only callables: cross-org usage summary + billingConfig editor.
// Spec: docs/superpowers/specs/2026-06-11-platform-admin-usage-billing-design.md
// NEVER returns shipment fields (PHI) — counts and org metadata only.
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { requirePlatformAdmin } from './lib/admin-guard.js'
import { monthKeyCentral } from './lib/usage.js'

export const getOrgUsageSummary = onCall(async (request) => {
  const { uid, email } = await requirePlatformAdmin(request)

  let months = request.data?.months
  if (months !== undefined) {
    if (!Array.isArray(months)) {
      throw new HttpsError('invalid-argument', 'months must be an array')
    }
    for (const m of months) {
      if (typeof m !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) {
        throw new HttpsError('invalid-argument', `Invalid month key: ${m}`)
      }
    }
  } else {
    const current = monthKeyCentral(new Date())
    if (!current) throw new HttpsError('internal', 'Could not derive current month')
    const [yearStr, monthStr] = current.split('-')
    let year = parseInt(yearStr, 10)
    let month = parseInt(monthStr, 10)
    month -= 1
    if (month === 0) {
      month = 12
      year -= 1
    }
    const previous = `${year}-${String(month).padStart(2, '0')}`
    months = [current, previous]
  }

  const firestore = getFirestore()
  const orgsSnap = await firestore.collection('organizations').get()
  const orgs = []

  for (const doc of orgsSnap.docs) {
    try {
      const data = doc.data()
      const slug = doc.id

      // memberCount
      const membersSnap = await firestore.collection(`organizations/${slug}/members`).count().get()
      const memberCount = membersSnap.data().count

      // statusCounts
      const statuses = ['pending', 'shipped', 'in_transit', 'delivered', 'exception']
      const statusCounts = {}
      for (const status of statuses) {
        const snap = await firestore
          .collection(`organizations/${slug}/shipments`)
          .where('status', '==', status)
          .count()
          .get()
        statusCounts[status] = snap.data().count
      }

      // monthly usage for requested months
      const monthly = {}
      for (const m of months) {
        monthly[m] = data.monthlyUsage?.[m] ?? null
      }

      orgs.push({
        slug,
        name: data.name ?? null,
        createdAt: data.createdAt?.toDate?.()?.toISOString() ?? data.createdAt ?? null,
        billingTier: data.billingConfig?.model ?? null,
        billingConfig: data.billingConfig ?? null,
        shipmentCount: data.shipmentCount ?? 0,
        monthly,
        memberCount,
        statusCounts,
      })
    } catch (err) {
      orgs.push({ slug: doc.id, error: 'summary_failed' })
    }
  }

  return { months, orgs }
})

export const updateOrgBillingConfig = onCall(async (request) => {
  const { uid, email } = await requirePlatformAdmin(request)

  const { orgSlug, billingConfig } = request.data || {}
  if (!orgSlug || typeof orgSlug !== 'string') {
    throw new HttpsError('invalid-argument', 'orgSlug required')
  }
  if (!billingConfig || typeof billingConfig !== 'object') {
    throw new HttpsError('invalid-argument', 'billingConfig required')
  }

  const validModels = ['flat', 'per_shipment', 'hybrid', 'custom']
  if (!validModels.includes(billingConfig.model)) {
    throw new HttpsError('invalid-argument', 'Invalid billing model')
  }

  const numericFields = ['baseFee', 'includedShipments', 'perShipmentRate']
  for (const field of numericFields) {
    const val = billingConfig[field]
    if (val !== null && val !== undefined) {
      if (typeof val !== 'number' || !isFinite(val) || val < 0) {
        throw new HttpsError('invalid-argument', `${field} must be a non-negative finite number or null`)
      }
    }
  }

  if (billingConfig.currency !== undefined && billingConfig.currency !== 'usd') {
    throw new HttpsError('invalid-argument', 'currency must be "usd"')
  }

  if (billingConfig.notes !== undefined) {
    if (typeof billingConfig.notes !== 'string' || billingConfig.notes.length > 2000) {
      throw new HttpsError('invalid-argument', 'notes must be a string <= 2000 characters')
    }
  }

  if (billingConfig.perCarrierRates !== undefined) {
    if (typeof billingConfig.perCarrierRates !== 'object' || billingConfig.perCarrierRates === null) {
      throw new HttpsError('invalid-argument', 'perCarrierRates must be an object')
    }
    for (const [key, val] of Object.entries(billingConfig.perCarrierRates)) {
      if (typeof val !== 'number' || !isFinite(val) || val < 0) {
        throw new HttpsError('invalid-argument', `perCarrierRates.${key} must be a non-negative finite number`)
      }
    }
  }

  const firestore = getFirestore()
  const orgRef = firestore.doc(`organizations/${orgSlug}`)
  const orgSnap = await orgRef.get()
  if (!orgSnap.exists) {
    throw new HttpsError('not-found', 'Organization not found')
  }

  const before = orgSnap.data().billingConfig ?? null

  await orgRef.update({ billingConfig })

  try {
    await firestore.collection('platformAudit').add({
      actor: uid,
      actorEmail: email,
      action: 'billing_config_update',
      orgSlug,
      before,
      after: billingConfig,
      at: FieldValue.serverTimestamp(),
    })
  } catch (err) {
    console.error('Audit write failed:', err)
    throw new HttpsError('internal', 'audit write failed')
  }

  return { ok: true }
})
