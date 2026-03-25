/**
 * Migrate V1 deliveries to V2 shipments collection.
 * Uses Firestore REST API with firebase-tools stored credentials.
 * 
 * V1 path: artifacts/delivery-manifest-c3deb/public/data/manifest
 * V2 path: organizations/{orgSlug}/shipments
 * 
 * Usage: node scripts/migrate-v1-to-v2.cjs <orgSlug> [--dry-run]
 */

const path = require('path')
const https = require('https')

const PROJECT_ID = 'delivery-manifest-c3deb'
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`
const FIREBASE_CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com'
const FIREBASE_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi'

const orgSlug = process.argv[2]
const dryRun = process.argv.includes('--dry-run')

if (!orgSlug) {
  console.error('Usage: node scripts/migrate-v1-to-v2.cjs <orgSlug> [--dry-run]')
  process.exit(1)
}

const firebaseToolsConfig = require(path.join(process.env.USERPROFILE, '.config', 'configstore', 'firebase-tools.json'))
const refreshToken = firebaseToolsConfig.tokens?.refresh_token
if (!refreshToken) {
  console.error('No firebase-tools refresh token. Run: npx firebase-tools login')
  process.exit(1)
}

let accessToken = null

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const reqOpts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: { ...options.headers },
    }
    const req = https.request(reqOpts, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }) }
        catch { resolve({ status: res.statusCode, data }) }
      })
    })
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

async function getToken() {
  if (accessToken) return accessToken
  const res = await httpRequest('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: FIREBASE_CLIENT_ID,
      client_secret: FIREBASE_CLIENT_SECRET,
    }).toString(),
  })
  if (!res.data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(res.data)}`)
  accessToken = res.data.access_token
  return accessToken
}

async function listCollection(collPath) {
  const token = await getToken()
  const docs = []
  let pageToken = ''
  
  do {
    const url = `${BASE_URL}/${collPath}?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`
    const res = await httpRequest(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status !== 200) throw new Error(`List ${collPath} failed (${res.status}): ${JSON.stringify(res.data)}`)
    if (res.data.documents) docs.push(...res.data.documents)
    pageToken = res.data.nextPageToken || ''
  } while (pageToken)

  return docs
}

async function createDoc(collPath, fields) {
  const token = await getToken()
  const url = `${BASE_URL}/${collPath}`
  const res = await httpRequest(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  })
  if (res.status !== 200) throw new Error(`Create failed (${res.status}): ${JSON.stringify(res.data)}`)
  // Extract doc ID from the name
  const name = res.data.name || ''
  return name.split('/').pop()
}

// Convert Firestore REST document to plain JS object
function docToObject(doc) {
  const obj = {}
  if (!doc.fields) return obj
  for (const [key, val] of Object.entries(doc.fields)) {
    obj[key] = firestoreValueToJS(val)
  }
  // Extract doc ID
  obj._id = (doc.name || '').split('/').pop()
  return obj
}

function firestoreValueToJS(val) {
  if ('stringValue' in val) return val.stringValue
  if ('integerValue' in val) return Number(val.integerValue)
  if ('doubleValue' in val) return val.doubleValue
  if ('booleanValue' in val) return val.booleanValue
  if ('nullValue' in val) return null
  if ('timestampValue' in val) return val.timestampValue
  if ('arrayValue' in val) return (val.arrayValue.values || []).map(firestoreValueToJS)
  if ('mapValue' in val) {
    const m = {}
    for (const [k, v] of Object.entries(val.mapValue.fields || {})) m[k] = firestoreValueToJS(v)
    return m
  }
  return null
}

// Convert JS value to Firestore REST format
function jsToFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null }
  if (typeof val === 'string') return { stringValue: val }
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { integerValue: String(val) }
    return { doubleValue: val }
  }
  if (typeof val === 'boolean') return { booleanValue: val }
  if (val instanceof Date) return { timestampValue: val.toISOString() }
  if (Array.isArray(val)) return { arrayValue: { values: val.map(jsToFirestoreValue) } }
  if (typeof val === 'object') {
    const fields = {}
    for (const [k, v] of Object.entries(val)) fields[k] = jsToFirestoreValue(v)
    return { mapValue: { fields } }
  }
  return { nullValue: null }
}

function jsObjectToFields(obj) {
  const fields = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k === '_id') continue
    if (v === '__SERVER_TIMESTAMP__') {
      fields[k] = { timestampValue: new Date().toISOString() }
    } else {
      fields[k] = jsToFirestoreValue(v)
    }
  }
  return fields
}

function guessCarrier(tracking) {
  if (!tracking) return 'unknown'
  const t = tracking.trim().toUpperCase()
  if (t.startsWith('1Z')) return 'ups'
  if (t.startsWith('9') && t.length >= 20 && t.length <= 22) return 'usps'
  if (/^\d{12,34}$/.test(t)) return 'fedex'
  return 'ups'
}

function mapStatus(v1Status) {
  if (!v1Status) return 'pending'
  const s = v1Status.toLowerCase().trim()
  const map = {
    'pending': 'pending', 'shipped': 'shipped',
    'in transit': 'in_transit', 'in_transit': 'in_transit',
    'delivered': 'delivered', 'exception': 'exception',
    'out for delivery': 'in_transit',
  }
  return map[s] || 'pending'
}

async function migrate() {
  console.log(`\n📦 Migrating V1 deliveries → V2 shipments`)
  console.log(`   V1: artifacts/${PROJECT_ID}/public/data/manifest`)
  console.log(`   V2: organizations/${orgSlug}/shipments`)
  console.log(`   Mode: ${dryRun ? '🔍 DRY RUN' : '🚀 LIVE'}\n`)

  // Read V1
  const v1Docs = await listCollection(`artifacts/${PROJECT_ID}/public/data/manifest`)
  console.log(`Found ${v1Docs.length} V1 deliveries`)
  if (v1Docs.length === 0) { console.log('Nothing to migrate!'); return }

  const v1Objects = v1Docs.map(docToObject)
  const sample = v1Objects[0]
  console.log(`Sample V1 fields: ${Object.keys(sample).filter(k => k !== '_id').join(', ')}`)
  console.log(`Sample: ${sample.patientName || '?'} | ${sample.date} | ${sample.trackingNumber || 'no tracking'}\n`)

  // Read V2 for dedup
  const v2Docs = await listCollection(`organizations/${orgSlug}/shipments`)
  const existingByTracking = new Map()
  const existingByDatePatient = new Map()

  for (const d of v2Docs.map(docToObject)) {
    if (d.trackingNumber) existingByTracking.set(d.trackingNumber.trim(), d._id)
    const key = `${d.date}|${(d.patientName || '').toLowerCase().trim()}`
    if (!existingByDatePatient.has(key)) {
      existingByDatePatient.set(key, { id: d._id, rxNumbers: d.rxNumbers || [] })
    }
  }
  console.log(`Found ${v2Docs.length} existing V2 shipments\n`)

  let migrated = 0, skippedTracking = 0, skippedDatePatient = 0, errors = 0

  for (const v1 of v1Objects) {
    const trackingNumber = (v1.trackingNumber || '').trim()
    const patientName = (v1.patientName || '').trim()
    const date = v1.date || ''
    const rxNumbers = Array.isArray(v1.rxNumbers) ? v1.rxNumbers :
                      (typeof v1.rxNumbers === 'string' ? v1.rxNumbers.split(',').map(r => r.trim()).filter(Boolean) : [])

    if (trackingNumber && existingByTracking.has(trackingNumber)) {
      console.log(`  ⏭️  SKIP (tracking exists): ${patientName} — ${trackingNumber}`)
      skippedTracking++
      continue
    }

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

    const now = new Date().toISOString()
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
      createdAt: v1.createdAt || now,
      updatedAt: now,
      createdBy: 'migration:v1-to-v2',
      updatedBy: 'migration:v1-to-v2',
      deliveredAt: v1.status === 'delivered' ? (v1.deliveredAt || now) : null,
      shippedAt: v1.shippedAt || null,
      migratedFrom: `v1:${v1._id}`,
    }

    if (dryRun) {
      console.log(`  ✅ WOULD migrate: ${patientName} | ${date} | ${trackingNumber || 'no tracking'} | ${v2Doc.carrier} | ${v2Doc.status}`)
    } else {
      try {
        const fields = jsObjectToFields(v2Doc)
        const newId = await createDoc(`organizations/${orgSlug}/shipments`, fields)
        console.log(`  ✅ Migrated: ${patientName} | ${date} | ${trackingNumber || 'no tracking'} → ${newId}`)
        if (trackingNumber) existingByTracking.set(trackingNumber, newId)
        existingByDatePatient.set(datePatientKey, { id: newId, rxNumbers })
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

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
