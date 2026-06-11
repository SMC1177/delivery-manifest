// functions/usage-counters.js
// Server-side usage counters: organizations/{slug}.shipmentCount + monthlyUsage.
// Spec: docs/superpowers/specs/2026-06-11-platform-admin-usage-billing-design.md
// Counters are maintained server-side so clients cannot manipulate billing data.
import { onDocumentCreated, onDocumentDeleted } from 'firebase-functions/v2/firestore'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { shipmentMonthKey, carrierBucket, buildUsageDeltas } from './lib/usage.js'

export const onShipmentCreatedUsage = onDocumentCreated(
  'organizations/{orgSlug}/shipments/{shipmentId}',
  async (event) => {
    try {
      const data = event.data?.data()
      if (!data) return

      const { orgSlug, shipmentId } = event.params
      const monthKey = shipmentMonthKey(data, event.time)
      const bucket = carrierBucket(data.carrier)
      const deltas = buildUsageDeltas(monthKey, bucket, +1, FieldValue.increment)

      const db = getFirestore()
      await db.doc(`organizations/${orgSlug}`).set(deltas, { merge: true })

      console.log(`onShipmentCreatedUsage: org=${orgSlug}, shipment=${shipmentId}, monthKey=${monthKey}, bucket=${bucket}`)
    } catch (err) {
      console.error('onShipmentCreatedUsage error:', err)
    }
  }
)

export const onShipmentDeletedUsage = onDocumentDeleted(
  'organizations/{orgSlug}/shipments/{shipmentId}',
  async (event) => {
    try {
      const data = event.data?.data()
      if (!data) return

      const { orgSlug, shipmentId } = event.params
      const monthKey = shipmentMonthKey(data, null)
      const bucket = carrierBucket(data.carrier)

      const db = getFirestore()

      if (monthKey === null) {
        console.warn(`onShipmentDeletedUsage: no monthKey for org=${orgSlug}, shipment=${shipmentId} — decrementing shipmentCount only`)
        await db.doc(`organizations/${orgSlug}`).set(
          { shipmentCount: FieldValue.increment(-1) },
          { merge: true }
        )
        return
      }

      const deltas = buildUsageDeltas(monthKey, bucket, -1, FieldValue.increment)
      await db.doc(`organizations/${orgSlug}`).set(deltas, { merge: true })

      console.log(`onShipmentDeletedUsage: org=${orgSlug}, shipment=${shipmentId}, monthKey=${monthKey}, bucket=${bucket}`)
    } catch (err) {
      console.error('onShipmentDeletedUsage error:', err)
    }
  }
)
