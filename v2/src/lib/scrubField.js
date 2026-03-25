import { collection, getDocs, writeBatch, deleteField, doc } from 'firebase/firestore'
import { db } from './firebase'

// Fields that are never eligible for scrubbing (core fields)
export const CORE_FIELDS = ['patientName', 'trackingNumber', 'rxNumbers', 'date', 'status', 'carrier']

// Fields eligible for data scrubbing
export const SCRUBBABLE_FIELDS = ['address', 'phone', 'dob', 'notes', 'redeliver']

/**
 * Scrub (permanently delete) a field from all shipments in an organization.
 * Uses Firestore writeBatch with max 500 docs per batch.
 *
 * @param {string} orgSlug - Organization slug
 * @param {string} fieldKey - Field key to scrub
 * @returns {Promise<number>} Number of shipments updated
 */
export async function scrubFieldFromShipments(orgSlug, fieldKey) {
  if (!orgSlug) throw new Error('Organization slug is required')
  if (!fieldKey) throw new Error('Field key is required')
  if (CORE_FIELDS.includes(fieldKey)) {
    throw new Error(`Cannot scrub core field: ${fieldKey}`)
  }
  if (!SCRUBBABLE_FIELDS.includes(fieldKey)) {
    throw new Error(`Field is not eligible for scrubbing: ${fieldKey}`)
  }

  const colRef = collection(db, 'organizations', orgSlug, 'shipments')
  const snapshot = await getDocs(colRef)

  if (snapshot.empty) return 0

  const docs = snapshot.docs
  let updated = 0

  // Process in batches of 500 (Firestore limit)
  for (let i = 0; i < docs.length; i += 500) {
    const batch = writeBatch(db)
    const chunk = docs.slice(i, i + 500)
    let batchCount = 0

    for (const shipmentDoc of chunk) {
      const data = shipmentDoc.data()
      if (fieldKey in data && data[fieldKey] !== undefined) {
        batch.update(doc(db, 'organizations', orgSlug, 'shipments', shipmentDoc.id), {
          [fieldKey]: deleteField(),
        })
        batchCount++
      }
    }

    if (batchCount > 0) {
      await batch.commit()
      updated += batchCount
    }
  }

  return updated
}
