// functions/usage-reconcile.js
// Monthly recount of organizations/{slug}.monthlyUsage + shipmentCount from shipment docs.
// Spec: docs/superpowers/specs/2026-06-11-platform-admin-usage-billing-design.md
// Buckets in code (NOT per-carrier count() queries) because legacy docs have
// uppercase carrier values that case-sensitive == queries would silently miss.
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore'
import { monthKeyCentral, carrierBucket } from './lib/usage.js'

export function emptyBucket() {
  return { ups: 0, fedex: 0, usps: 0, other: 0, total: 0 }
}

export async function recountOrgMonth(db, orgSlug, monthKey) {
  // Returns { before, after, changed } and persists when changed
  // 1. Compute a UTC query window that safely covers the CT month:
  //    windowStart = new Date(`${monthKey}-01T00:00:00Z`) minus 1 day;
  //    windowEnd = first day of the NEXT month at T00:00:00Z plus 1 day.
  const [year, month] = monthKey.split('-').map(Number)
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear = month === 12 ? year + 1 : year
  const windowStart = new Date(`${monthKey}-01T00:00:00Z`)
  windowStart.setDate(windowStart.getDate() - 1)
  const windowEnd = new Date(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00Z`)
  windowEnd.setDate(windowEnd.getDate() + 1)

  // 2. Query shipments with projection
  const shipmentsRef = db.collection(`organizations/${orgSlug}/shipments`)
  const snapshot = await shipmentsRef
    .where('createdAt', '>=', Timestamp.fromDate(windowStart))
    .where('createdAt', '<', Timestamp.fromDate(windowEnd))
    .select('carrier', 'createdAt')
    .get()

  const bucket = emptyBucket()
  for (const doc of snapshot.docs) {
    const data = doc.data()
    if (monthKeyCentral(data.createdAt) !== monthKey) continue
    const carrier = carrierBucket(data.carrier)
    bucket[carrier]++
    bucket.total++
  }
  // KNOWN LIMIT: docs lacking createdAt entirely are invisible to the range query
  // and stay unreconciled — the app always sets createdAt via serverTimestamp,
  // and such docs would surface as persistent drift in the audit trail.

  // 3. Read current stored values
  const orgRef = db.doc(`organizations/${orgSlug}`)
  const orgSnap = await orgRef.get()
  const orgData = orgSnap.data() || {}
  const storedMonth = (orgData.monthlyUsage && orgData.monthlyUsage[monthKey]) || {}
  const beforeBucket = { ...emptyBucket(), ...storedMonth }
  const beforeShipmentCount = orgData.shipmentCount || 0

  // Recount lifetime shipment count
  const allShipmentsSnap = await shipmentsRef.count().get()
  const lifetimeCount = allShipmentsSnap.data().count

  // 4. Compare
  const bucketEqual = (
    beforeBucket.ups === bucket.ups &&
    beforeBucket.fedex === bucket.fedex &&
    beforeBucket.usps === bucket.usps &&
    beforeBucket.other === bucket.other &&
    beforeBucket.total === bucket.total
  )
  if (bucketEqual && beforeShipmentCount === lifetimeCount) {
    return { changed: false }
  }

  // 5. Update
  const updateData = {
    [`monthlyUsage.${monthKey}`]: bucket,
    shipmentCount: lifetimeCount
  }
  await orgRef.update(updateData)

  // Audit entry
  const auditRef = db.collection('platformAudit').doc()
  await auditRef.set({
    actor: 'system:reconcile',
    action: 'usage_recount',
    orgSlug,
    monthKey,
    before: { monthlyUsage: { [monthKey]: beforeBucket }, shipmentCount: beforeShipmentCount },
    after: { monthlyUsage: { [monthKey]: bucket }, shipmentCount: lifetimeCount },
    at: FieldValue.serverTimestamp()
  })

  return {
    changed: true,
    before: { monthlyUsage: { [monthKey]: beforeBucket }, shipmentCount: beforeShipmentCount },
    after: { monthlyUsage: { [monthKey]: bucket }, shipmentCount: lifetimeCount }
  }
}

export const reconcileUsageMonthly = onSchedule(
  { schedule: '0 4 1 * *', timeZone: 'America/Chicago' },
  async () => {
    // recount previous + current CT month for every org
    const db = getFirestore()
    const now = new Date()
    const currentMonthKey = monthKeyCentral(now)
    // Derive previous month key by string math
    const [year, month] = currentMonthKey.split('-').map(Number)
    const prevMonth = month === 1 ? 12 : month - 1
    const prevYear = month === 1 ? year - 1 : year
    const previousMonthKey = `${prevYear}-${String(prevMonth).padStart(2, '0')}`

    const orgsSnap = await db.collection('organizations').get()
    let orgsProcessed = 0
    let monthsTouched = 0
    let changesMade = 0

    for (const orgDoc of orgsSnap.docs) {
      const orgSlug = orgDoc.id
      orgsProcessed++
      for (const monthKey of [previousMonthKey, currentMonthKey]) {
        monthsTouched++
        try {
          const result = await recountOrgMonth(db, orgSlug, monthKey)
          if (result.changed) changesMade++
        } catch (e) {
          console.error(`[reconcileUsageMonthly] error for org ${orgSlug}, month ${monthKey}:`, e.message)
          // Non-fatal — continue with other orgs
        }
      }
    }

    // Note: a shipment created while reconcile runs can be double-corrected next cycle —
    // reconcile is idempotent so the steady state is correct.
    console.log(`[reconcileUsageMonthly] orgs: ${orgsProcessed}, months: ${monthsTouched}, changes: ${changesMade}`)
  }
)
