#!/usr/bin/env node

/**
 * Migration script: moves deliveries from v1 flat collection
 * to v2 organization-scoped structure.
 *
 * Usage:
 *   node scripts/migrate.js [--dry-run]
 *
 * Reads Firebase CLI credentials automatically.
 * Use --dry-run to preview without writing.
 */

import { execSync } from 'child_process'
import { writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// --- CONFIG ---
const PROJECT_ID = 'delivery-manifest-c3deb'
const V1_COLLECTION = 'artifacts/delivery-manifest-c3deb/public/data/manifest'
const V2_ORG_SLUG = 'woodlandsrx'
const V2_COLLECTION = `organizations/${V2_ORG_SLUG}/shipments`

// --- AUTH (reuse Firebase CLI refresh token) ---
async function getAccessToken() {
  const refreshToken = execSync(
    `node -e "const c=require('C:/Users/SMC11/AppData/Roaming/npm/node_modules/firebase-tools/lib/configstore.js');const t=c.configstore?c.configstore.get('tokens'):c.default?.configstore?.get('tokens');if(t)process.stdout.write(t.refresh_token||'')"`,
    { encoding: 'utf8' }
  ).trim()

  if (!refreshToken) throw new Error('No Firebase CLI refresh token found. Run: npx firebase login')

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const data = await res.json()
  if (!data.access_token) throw new Error('Failed to get access token: ' + JSON.stringify(data))
  return data.access_token
}

// --- FIRESTORE REST HELPERS ---
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`

async function listDocuments(token, collectionPath) {
  const docs = []
  let pageToken = null

  do {
    const url = new URL(`${BASE}/${collectionPath}`)
    url.searchParams.set('pageSize', '300')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    const data = await res.json()

    if (data.documents) docs.push(...data.documents)
    pageToken = data.nextPageToken || null
  } while (pageToken)

  return docs
}

async function createDocument(token, collectionPath, docId, fields) {
  const url = `${BASE}/${collectionPath}?documentId=${docId}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(`Write failed for ${docId}: ${err.error?.message || JSON.stringify(err)}`)
  }
  return res.json()
}

// --- FIELD CONVERSION ---
function firestoreValueToJs(val) {
  if (val.stringValue !== undefined) return val.stringValue
  if (val.integerValue !== undefined) return Number(val.integerValue)
  if (val.doubleValue !== undefined) return val.doubleValue
  if (val.booleanValue !== undefined) return val.booleanValue
  if (val.timestampValue !== undefined) return val.timestampValue
  if (val.arrayValue) return (val.arrayValue.values || []).map(firestoreValueToJs)
  if (val.mapValue) {
    const obj = {}
    for (const [k, v] of Object.entries(val.mapValue.fields || {})) obj[k] = firestoreValueToJs(v)
    return obj
  }
  return null
}

function jsToFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null }
  if (typeof val === 'string') return { stringValue: val }
  if (typeof val === 'number') return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val }
  if (typeof val === 'boolean') return { booleanValue: val }
  if (Array.isArray(val)) return { arrayValue: { values: val.map(jsToFirestoreValue) } }
  if (val instanceof Date) return { timestampValue: val.toISOString() }
  if (typeof val === 'object') {
    const fields = {}
    for (const [k, v] of Object.entries(val)) fields[k] = jsToFirestoreValue(v)
    return { mapValue: { fields } }
  }
  return { stringValue: String(val) }
}

function buildV2Fields(v1) {
  // Parse rx numbers — separate out "redeliver" notes
  let rxNumbers = v1.rxNumbers || []
  let redeliver = false
  let notes = ''

  if (Array.isArray(rxNumbers)) {
    const cleaned = []
    for (const rx of rxNumbers) {
      const lower = String(rx).toLowerCase()
      if (lower.includes('redeliver')) {
        redeliver = true
        // Extract just the rx number if mixed: "1234567 redeliver" → "1234567"
        const numOnly = String(rx).replace(/redeliver/gi, '').trim()
        if (numOnly) cleaned.push(numOnly)
      } else {
        cleaned.push(String(rx).trim())
      }
    }
    rxNumbers = cleaned.filter(Boolean)
  }

  if (redeliver) notes = 'Redeliver'

  // Determine status
  let status = 'pending'
  if (v1.trackingNumber && v1.trackingNumber.trim()) {
    status = 'shipped'
  }

  return {
    patientName: jsToFirestoreValue(v1.patientName || ''),
    rxNumbers: jsToFirestoreValue(rxNumbers),
    trackingNumber: jsToFirestoreValue(v1.trackingNumber || ''),
    carrier: jsToFirestoreValue(v1.trackingNumber ? 'UPS' : ''),
    status: jsToFirestoreValue(status),
    redeliver: jsToFirestoreValue(redeliver),
    notes: jsToFirestoreValue(notes),
    createdAt: jsToFirestoreValue(v1.date ? new Date(v1.date + 'T00:00:00') : new Date()),
    updatedAt: jsToFirestoreValue(new Date()),
    createdBy: jsToFirestoreValue('migration-v1'),
    _v1Id: jsToFirestoreValue(v1._docId || ''),
  }
}

// --- MAIN ---
async function main() {
  const dryRun = process.argv.includes('--dry-run')

  console.log('=== Delivery Manifest v1 → v2 Migration ===')
  console.log(`Source: ${V1_COLLECTION}`)
  console.log(`Target: ${V2_COLLECTION}`)
  if (dryRun) console.log('⚠️  DRY RUN — no writes will be made\n')
  else console.log('')

  // Auth
  console.log('Authenticating...')
  const token = await getAccessToken()
  console.log('✅ Authenticated\n')

  // Read v1 data
  console.log('Reading v1 documents...')
  const v1Docs = await listDocuments(token, V1_COLLECTION)
  console.log(`Found ${v1Docs.length} documents\n`)

  if (v1Docs.length === 0) {
    console.log('Nothing to migrate. Exiting.')
    process.exit(0)
  }

  // Parse v1 documents
  const records = v1Docs.map((doc) => {
    const docId = doc.name.split('/').pop()
    const fields = {}
    for (const [k, v] of Object.entries(doc.fields || {})) {
      fields[k] = firestoreValueToJs(v)
    }
    fields._docId = docId
    return fields
  })

  // Backup
  const backupPath = resolve(__dirname, `backup-${new Date().toISOString().slice(0, 10)}.json`)
  writeFileSync(backupPath, JSON.stringify(records, null, 2))
  console.log(`Backup saved: ${backupPath}\n`)

  // Preview
  console.log('--- Preview (first 3 records) ---')
  for (const rec of records.slice(0, 3)) {
    console.log(`  ${rec.date || 'no-date'} | ${rec.patientName} | Rx: ${(rec.rxNumbers || []).join(', ')} | Tracking: ${rec.trackingNumber || 'none'}`)
  }
  console.log('')

  if (dryRun) {
    console.log(`DRY RUN complete. ${records.length} records would be migrated.`)
    process.exit(0)
  }

  // Migrate
  let migrated = 0
  let errors = 0

  for (const rec of records) {
    try {
      const v2Fields = buildV2Fields(rec)
      await createDocument(token, V2_COLLECTION, rec._docId, v2Fields)
      migrated++
      process.stdout.write(`\rMigrated: ${migrated}/${records.length}`)
    } catch (err) {
      errors++
      console.error(`\n❌ ${rec._docId}: ${err.message}`)
    }
  }

  console.log('\n\n=== Migration Complete ===')
  console.log(`  ✅ ${migrated} shipments migrated`)
  if (errors) console.log(`  ❌ ${errors} errors`)
  console.log(`  📁 Backup: ${backupPath}`)
  console.log(`  📍 Target: ${V2_COLLECTION}`)

  process.exit(errors > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
