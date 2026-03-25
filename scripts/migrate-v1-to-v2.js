/**
 * Migrate V1 deliveries to V2 shipments collection.
 * 
 * V1 path: artifacts/delivery-manifest-c3deb/public/data/manifest
 * V2 path: organizations/{orgSlug}/shipments
 * 
 * Dedup: skips if a shipment with the same trackingNumber already exists,
 *        or if same date + patientName + overlapping rxNumbers exists.
 * 
 * Usage: node scripts/migrate-v1-to-v2.js <orgSlug>
 *   e.g. node scripts/migrate-v1-to-v2.js woodlands-pm
 * 
 * Dry run (preview only): node scripts/migrate-v1-to-v2.js <orgSlug> --dry-run
 */

import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const orgSlug = process.argv[2]
const dryRun = process.argv.includes('--dry-run')

if (!orgSlug) {
  console.error('Usage: node scripts/migrate-v1-to-v2.js <orgSlug> [--dry-run]')
  process.exit(1)
}

// Initialize with default credentials (uses GOOGLE_APPLICATION_CREDENTIALS or gcloud auth)
initializeApp({ projectId: 'delivery-manifest-c3deb' })
const db = getFirestore()

const V1_PATH = 'artifacts/delivery-manifest-c3deb/public/data/manifest'
const V2_PATH = `organizations/${orgSlug}/shipments`

async function migrate() {
  console.log(`\n📦 Migrating V1 deliveries → V2 shipments`)
  console.log(`   V1: ${V1_PATH}`)
  console.log(`   V2: ${V2_PATH}`)
  console.log(`   Org: ${orgSlug}`)
  console.log(`   Mode: ${dryRun ? '🔍 DRY RUN' : '🚀 LIVE'}\n`)

  // 1. Read all V1 docs
  const v1Snap = await db.collection(V1_PATH).get()
  console.log(`Found ${v1Snap.size} V1 deliveries`)

  if (v1Snap.empty) {
    console.log('Nothing to migrate!')
    return
  }

  // 2. Read all existing V2 docs for dedup
  const v2Snap = await db.collection(V2_PATH).get()
  const existingByTracking = new Map()
  const existingByDatePatient = new Map()

  for (const doc of v2Snap.docs) {
    const d = doc.data()
    if (d.trackingNumber) {
      existingByTracking.set(d.trackingNumber.trim(), doc.id)
    }
    const key = `${d.date}|${(d.patientName || '').toLowerCase().trim()}`
    if (!existingByDatePatient.has(key)) {
      existingByDatePatient.set(key, { id: doc.id, rxNumbers: d.rxNumbers || [] })
    }
  }

  console.log(`Found ${v2Snap.size} existing V2 shipments\n`)

  let migrated = 0
  let skippedTracking = 0
  let skippedDatePatient = 0
  let errors = 0

  for (const v1Doc of v1Snap.docs) {
    const v1 = v1Doc.data()

    // Map V1 fields → V2 fields
    const trackingNumber = (v1.trackingNumber || '').trim()
    const patientName = (v1.patientName || '').trim()
    const date = v1.date || ''
    const rxNumbers = Array.isArray(v1.rxNumbers) ? v1.rxNumbers : 
                      (typeof v1.rxNumbers === 'string' ? v1.rxNumbers.split(',').map(r => r.trim()).filter(Boolean) : [])

    // Dedup check 1: same tracking number
    if (trackingNumber && existingByTracking.has(trackingNumber)) {
      console.log(`  ⏭️  SKIP (tracking exists): ${patientName} — ${trackingNumber}`)
      skippedTracking++
      continue
    }

    // Dedup check 2: same date + patient name + overlapping Rx
    const datePatientKey = `${date}|${patientName.toLowerCase()}`
    if (existingByDatePatient.has(datePatientKey)) {
      const existing = existingByDatePatient.get(datePatientKey)
      const overlap = rxNumbers.some(rx => existing.rxNumbers.includes(rx))
      if (overlap) {
        console.log(`  ⏭️  SKIP (date+patient+rx overlap): ${patientName} — ${date}`)
        skippedDatePatient++
        continue
      }
    }

    // Build V2 document
    const v2Doc = {
      patientName,
      address: (v1.address || '').trim(),
      phone: (v1.phone || '').trim(),
      rxNumbers,
      trackingNumber,
      carrier: guessCarrier(trackingNumber),
      status: mapStatus(v1.status),
      date,
      notes: (v1.notes || '').trim(),
      createdAt: v1.createdAt ? new Date(v1.createdAt) : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      createdBy: 'migration:v1-to-v2',
      updatedBy: 'migration:v1-to-v2',
      deliveredAt: v1.status === 'delivered' ? (v1.deliveredAt ? new Date(v1.deliveredAt) : FieldValue.serverTimestamp()) : null,
      shippedAt: v1.shippedAt ? new Date(v1.shippedAt) : null,
      migratedFrom: `v1:${v1Doc.id}`,
    }

    if (dryRun) {
      console.log(`  ✅ WOULD migrate: ${patientName} | ${date} | ${trackingNumber || 'no tracking'} | ${v2Doc.carrier} | ${v2Doc.status}`)
    } else {
      try {
        const ref = await db.collection(V2_PATH).add(v2Doc)
        console.log(`  ✅ Migrated: ${patientName} | ${date} | ${trackingNumber || 'no tracking'} → ${ref.id}`)
        
        // Add to dedup maps so subsequent V1 docs don't duplicate
        if (trackingNumber) existingByTracking.set(trackingNumber, ref.id)
        existingByDatePatient.set(datePatientKey, { id: ref.id, rxNumbers })
      } catch (err) {
        console.error(`  ❌ ERROR: ${patientName} — ${err.message}`)
        errors++
      }
    }
    migrated++
  }

  console.log(`\n📊 Summary:`)
  console.log(`   ${dryRun ? 'Would migrate' : 'Migrated'}: ${migrated}`)
  console.log(`   Skipped (tracking dupe): ${skippedTracking}`)
  console.log(`   Skipped (date+patient dupe): ${skippedDatePatient}`)
  if (errors) console.log(`   Errors: ${errors}`)
  console.log()
}

/**
 * Guess carrier from tracking number format.
 * FedEx: 12-34 digits (usually 12, 15, 20, 22)
 * UPS: starts with 1Z
 * USPS: starts with 9 and is 20-22 digits
 */
function guessCarrier(tracking) {
  if (!tracking) return 'unknown'
  const t = tracking.trim().toUpperCase()
  if (t.startsWith('1Z')) return 'ups'
  if (t.startsWith('9') && t.length >= 20 && t.length <= 22) return 'usps'
  if (/^\d{12,34}$/.test(t)) return 'fedex'
  return 'ups' // default for WPM
}

/**
 * Map V1 status to V2 status values.
 */
function mapStatus(v1Status) {
  if (!v1Status) return 'pending'
  const s = v1Status.toLowerCase().trim()
  const map = {
    'pending': 'pending',
    'shipped': 'shipped',
    'in transit': 'in_transit',
    'in_transit': 'in_transit',
    'delivered': 'delivered',
    'exception': 'exception',
    'out for delivery': 'in_transit',
  }
  return map[s] || 'pending'
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
