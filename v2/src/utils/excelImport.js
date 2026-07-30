import * as XLSX from 'xlsx'
import { detectCarrier } from '../lib/carriers'

/** Universal fields that shipments are stored with */
export const UNIVERSAL_FIELDS = [
  { key: 'patientName', label: 'Patient Name', required: true },
  { key: 'phone', label: 'Phone', required: false },
  { key: 'dateOfBirth', label: 'Date of Birth', required: false },
  { key: 'rxNumbers', label: 'RX Numbers', required: false },
  { key: 'trackingNumber', label: 'Tracking #', required: false },
  { key: 'address', label: 'Address', required: false, isAddress: true },
  { key: 'carrier', label: 'Carrier', required: false },
  { key: 'date', label: 'Date', required: false },
  { key: 'refillNumber', label: 'Refill #', required: false },
  { key: 'notes', label: 'Notes', required: false },
]

/** Address sub-field keys for multi-column address concatenation */
export const ADDRESS_SUBFIELDS = ['address1', 'address2', 'city', 'state', 'zip']

/**
 * Fuzzy auto-mapping rules: [pattern, fieldKey]
 * Patterns are checked case-insensitively via .includes()
 */
const FUZZY_RULES = [
  // patientName
  [/customer\s*name|patient\s*name/i, 'patientName'],
  // phone
  [/phone/i, 'phone'],
  // dateOfBirth
  [/birthday|birth|dob/i, 'dateOfBirth'],
  // rxNumbers
  [/rx.*number|rx\s*#|prescription/i, 'rxNumbers'],
  // trackingNumber
  [/tracking/i, 'trackingNumber'],
  // address sub-fields — require "Ship To" prefix or exact standalone match
  [/ship\s*to\s*address\s*1|address\s*1|address1|street/i, 'address1'],
  [/ship\s*to\s*address\s*2|address\s*2|address2|apt|suite/i, 'address2'],
  [/ship\s*to\s*city|^city$/i, 'city'],
  [/ship\s*to\s*state|^state$/i, 'state'],
  [/ship\s*to\s*zip|^zip\s*code$|^zip$|postal/i, 'zip'],
  // carrier
  [/delivery\s*method|carrier|ship\s*method/i, 'carrier'],
  // date
  [/date\s*filled|fill\s*date|dispensed\s*date|date\s*written|date\s*dispensed|date\s*shipped|ship\s*date/i, 'date'],
  // refillNumber
  [/refill\s*#|refill\s*number|refill\s*no|nbr\s*of\s*refill/i, 'refillNumber'],
  // notes
  [/dispensed\s*drug|drug\s*description|drug\s*name/i, 'notes'],
]

/**
 * Read headers and first data row from an Excel file.
 * @param {File} file
 * @returns {Promise<{ headers: string[], sampleRow: Record<string, unknown> }>}
 */
export async function readExcelHeaders(file) {
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: 'array' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })

  if (rawData.length < 1) return { headers: [], sampleRow: {} }

  const headers = rawData[0].map((h) => String(h).trim())
  const sampleRow = {}
  if (rawData.length >= 2) {
    headers.forEach((h, i) => {
      sampleRow[h] = rawData[1][i] ?? ''
    })
  }
  return { headers, sampleRow }
}

/**
 * Auto-map Excel column headers to universal field keys using fuzzy matching.
 * Returns a partial ColumnMappings object (only matched fields).
 * Address fields are returned as address sub-keys (address1, city, etc.)
 *
 * @param {string[]} headers
 * @returns {Record<string, string | string[]>} mapping where key=universalField, value=excelHeader(s)
 */
export function autoMapColumns(headers) {
  const mapping = {}
  const addressParts = {}

  for (const header of headers) {
    for (const [regex, fieldKey] of FUZZY_RULES) {
      if (!regex.test(header)) continue

      // Address sub-fields get collected separately
      if (ADDRESS_SUBFIELDS.includes(fieldKey)) {
        addressParts[fieldKey] = header
      } else if (!mapping[fieldKey]) {
        mapping[fieldKey] = header
      }
      break // first match wins
    }
  }

  // Combine address sub-fields into address array
  const addrColumns = ADDRESS_SUBFIELDS.map((k) => addressParts[k]).filter(Boolean)
  if (addrColumns.length > 0) {
    mapping.address = addrColumns
  }

  return mapping
}

/**
 * Concatenate multiple address columns into a single string.
 * Skips empty parts. Format: "Addr1, Addr2, City, ST Zip"
 *
 * @param {Record<string, unknown>} row - keyed by Excel header
 * @param {string[]} addressColumns - ordered list of Excel column headers for address
 * @returns {string}
 */
export function concatenateAddress(row, addressColumns) {
  if (!addressColumns || !Array.isArray(addressColumns)) return ''
  return addressColumns
    .map((col) => {
      const val = row[col]
      return val ? String(val).trim() : ''
    })
    .filter(Boolean)
    .join(', ')
}

/**
 * Normalize a date value from Excel into YYYY-MM-DD string.
 */
export function normalizeDate(value) {
  if (value == null || value === '') return ''

  if (value instanceof Date) {
    if (isNaN(value.getTime())) return ''
    return value.toISOString().slice(0, 10)
  }

  if (typeof value === 'number') {
    const ms = (value - 25569) * 86400 * 1000
    const d = new Date(ms)
    if (isNaN(d.getTime())) return ''
    return d.toISOString().slice(0, 10)
  }

  const str = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str

  const mdyMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (mdyMatch) {
    const [, m, d, y] = mdyMatch
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }

  if (/^\d+$/.test(str)) return normalizeDate(Number(str))

  return ''
}

/**
 * Detect carrier from tracking number with fallback to 'other'.
 */
export function detectCarrierFromTracking(trackingNumber) {
  if (!trackingNumber) return 'other'
  const tn = String(trackingNumber).trim()
  return detectCarrier(tn) || 'other'
}

/**
 * Parse Rx numbers from a cell value. Splits on comma, semicolon, or newline.
 */
function parseRxNumbers(value) {
  if (!value) return []
  const str = String(value).trim()
  if (!str) return []
  return str.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean)
}

/**
 * Apply a saved column mapping to parsed Excel rows.
 * Only mapped columns are included — all unmapped data is scrubbed.
 *
 * @param {Record<string, unknown>[]} rows - rows keyed by Excel header
 * @param {Record<string, string | string[]>} mapping - universalField → Excel header(s)
 * @returns {MappedShipment[]}
 */
export function applyMapping(rows, mapping) {
  return rows.map((row) => {
    const get = (field) => {
      const col = mapping[field]
      if (!col) return undefined
      if (Array.isArray(col)) return concatenateAddress(row, col)
      return row[col]
    }

    const trackingRaw = get('trackingNumber')
    const tracking = trackingRaw ? String(trackingRaw).trim() : ''

    return {
      patientName: get('patientName') ? String(get('patientName')).trim() : '',
      phone: get('phone') ? String(get('phone')).trim() : '',
      dateOfBirth: get('dateOfBirth') ? normalizeDate(get('dateOfBirth')) : '',
      address: Array.isArray(mapping.address)
        ? concatenateAddress(row, mapping.address)
        : get('address') ? String(get('address')).trim() : '',
      rxNumbers: parseRxNumbers(get('rxNumbers')),
      trackingNumber: tracking,
      carrier: detectCarrierFromTracking(tracking),
      date: get('date') ? normalizeDate(get('date')) : '',
      refillNumber: get('refillNumber') ? String(get('refillNumber')).trim() : '',
      notes: get('notes') ? String(get('notes')).trim() : '',
    }
  })
}

/**
 * Determine which Excel columns are NOT in the mapping (will be scrubbed).
 *
 * @param {string[]} allHeaders - all Excel column headers
 * @param {Record<string, string | string[]>} mapping - saved column mapping
 * @returns {string[]} unmapped column headers
 */
export function getUnmappedColumns(allHeaders, mapping) {
  const mappedHeaders = new Set()
  for (const val of Object.values(mapping)) {
    if (Array.isArray(val)) {
      val.forEach((v) => mappedHeaders.add(v))
    } else if (val) {
      mappedHeaders.add(val)
    }
  }
  return allHeaders.filter((h) => !mappedHeaders.has(h))
}

/**
 * Build a composite dedup key from tracking #, Rx numbers, and refill #.
 * All parts are lowercased and trimmed. Rx numbers are sorted for consistency.
 */
function buildDedupKey(trackingNumber, rxNumbers, refillNumber) {
  const tracking = (trackingNumber || '').trim().toLowerCase()
  const rx = Array.isArray(rxNumbers)
    ? rxNumbers.map(r => String(r).trim().toLowerCase()).sort().join('|')
    : String(rxNumbers || '').trim().toLowerCase()
  const refill = String(refillNumber || '').trim().toLowerCase()
  return `${tracking}::${rx}::${refill}`
}

/**
 * Build a patient-based fill key for matching tracking-less pending rows
 * against later tracking-bearing imports. Lowercases/trims all parts and sorts
 * Rx numbers the same way as buildDedupKey. Returns null if both rx and
 * refill are empty — without at least one, the key collapses to name+dob
 * and would wrongly merge two different prescriptions for the same person.
 */
function buildPatientFillKey(patientName, dob, rxNumbers, refillNumber) {
  const name = (patientName || '').trim().toLowerCase()
  const dobStr = (dob || '').trim().toLowerCase()
  const rx = Array.isArray(rxNumbers)
    ? rxNumbers.map(r => String(r).trim().toLowerCase()).sort().join('|')
    : String(rxNumbers || '').trim().toLowerCase()
  const refill = String(refillNumber || '').trim().toLowerCase()
  if (!rx && !refill) return null
  return `${name}::${dobStr}::${rx}::${refill}`
}

/**
 * Parse an Excel file using a saved column mapping.
 *
 * Dedup logic (for pharmacies that re-import daily with updated dates):
 * 1. Match by tracking # + Rx # + refill # (composite key)
 * 2. If composite key matches an existing shipment AND the new date is newer → update
 * 3. If composite key matches AND date is same or older → skip (true duplicate)
 * 4. If no tracking-key match, try matching a pending (tracking-less) shipment
 *    by patient name, DOB, Rx #s, and refill # (patient fill key)
 * 5. Rows without a tracking number are created as pending shipments; a later
 *    re-import with tracking numbers merges them via the patient fill key
 * 6. Ambiguous fill keys (matching multiple pending rows) are flagged for review
 *
 * @param {File} file
 * @param {Record<string, string | string[]>} mapping - column mapping
 * @param {Array<{id: string, trackingNumber: string, rxNumbers?: string[], refillNumber?: string, date?: string}>} existingShipments - full Firestore docs for smart dedup
 * @returns {Promise<ParsedImportResult>}
 */
export async function parseExcelFile(file, mapping, existingShipments = []) {
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: 'array' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]

  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  if (rows.length === 0) {
    return { shipments: [], updates: [], skippedNoTracking: 0, skippedDuplicate: 0, pendingCreated: 0, trackingMerged: 0, needsReview: 0, totalRows: 0, preview: [], unmappedColumns: [] }
  }

  const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
  const allHeaders = rawData[0].map((h) => String(h).trim())

  const allMapped = applyMapping(rows, mapping)
  const unmappedColumns = getUnmappedColumns(allHeaders, mapping)

  // Index existing shipments by composite key
  const existingByKey = new Map()
  for (const ship of existingShipments) {
    const key = buildDedupKey(ship.trackingNumber, ship.rxNumbers, ship.refillNumber)
    existingByKey.set(key, ship)
  }

  // Index existing tracking-less shipments by patient fill key
  const pendingByFillKey = new Map()
  const ambiguousFillKeys = new Set()
  for (const ship of existingShipments) {
    if (!ship.id) continue // skip docs without an id (should never happen, but guard)
    if (ship.trackingNumber && ship.trackingNumber.trim()) continue
    // Existing Firestore docs use 'dob' (not 'dateOfBirth') — the writer
    // in ImportPreviewModal persists the field under that name.  Incoming
    // mapped rows carry dateOfBirth (the mapped field name), so the key
    // for existing docs must read ship.dob first.
    const fillKey = buildPatientFillKey(ship.patientName, ship.dob || ship.dateOfBirth, ship.rxNumbers, ship.refillNumber)
    if (!fillKey) continue
    if (pendingByFillKey.has(fillKey)) {
      ambiguousFillKeys.add(fillKey)
    } else {
      pendingByFillKey.set(fillKey, ship)
    }
  }

  let skippedNoTracking = 0
  let skippedDuplicate = 0
  let pendingCreated = 0
  let trackingMerged = 0
  let needsReview = 0
  const shipments = [] // new inserts
  const updates = []   // existing records with newer dates
  const inFilePendingRows = new Map() // fillKey → in-file pending row (no id yet)

  for (const s of allMapped) {
    if (s.trackingNumber) {
      // Row has a tracking number — try exact dedup first
      const key = buildDedupKey(s.trackingNumber, s.rxNumbers, s.refillNumber)
      const existing = existingByKey.get(key)

      if (existing) {
        // Composite key matched — check if date is newer
        const newDate = s.date || ''
        const oldDate = existing.date || ''
        if (newDate > oldDate) {
          // Newer date → update the existing record
          updates.push({ shipmentId: existing.id, ...s })
        } else {
          // Same or older date → true duplicate, skip
          skippedDuplicate++
        }
      } else {
        // No match by tracking key — try pending merge
        const fillKey = buildPatientFillKey(s.patientName, s.dateOfBirth, s.rxNumbers, s.refillNumber)
        if (fillKey && pendingByFillKey.has(fillKey)) {
          if (ambiguousFillKeys.has(fillKey)) {
            needsReview++
            continue
          }
          const pending = pendingByFillKey.get(fillKey)
          updates.push({ shipmentId: pending.id, ...s })
          trackingMerged++
          pendingByFillKey.delete(fillKey)
        } else if (fillKey && inFilePendingRows.has(fillKey)) {
          // Matched an in-file pending row from the same spreadsheet —
          // set the tracking number on the already-queued row instead
          const inFileRow = inFilePendingRows.get(fillKey)
          inFileRow.trackingNumber = s.trackingNumber
          inFileRow.carrier = s.carrier
          trackingMerged++
          inFilePendingRows.delete(fillKey)
        } else {
          // No pending match either — brand-new shipment
          shipments.push(s)
        }
      }
    } else {
      // Row lacks a tracking number — create as pending
      const fillKey = buildPatientFillKey(s.patientName, s.dateOfBirth, s.rxNumbers, s.refillNumber)
      if (fillKey && (pendingByFillKey.has(fillKey) || inFilePendingRows.has(fillKey))) {
        // Already have a pending row with this fill key (persisted or in-file) — duplicate
        skippedDuplicate++
        continue
      }
      shipments.push(s)
      pendingCreated++
      if (fillKey) {
        inFilePendingRows.set(fillKey, s)
      }
    }
  }

  return {
    shipments,
    updates,
    skippedNoTracking,
    skippedDuplicate,
    pendingCreated,
    trackingMerged,
    needsReview,
    totalRows: allMapped.length,
    preview: shipments.slice(0, 5),
    unmappedColumns,
  }
}

/**
 * Re-map existing shipments by matching tracking numbers from a re-uploaded file.
 * Returns a preview of changes before applying — no writes happen here.
 *
 * @param {File} file - The original export file
 * @param {Record<string, string | string[]>} mapping - The column mapping to apply
 * @param {Array<{id: string, trackingNumber: string}>} existingShipments - Current Firestore docs
 * @returns {Promise<RemapPreview>}
 */
export async function previewRemap(file, mapping, existingShipments) {
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: 'array' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })

  if (rows.length === 0) {
    return { matched: [], unchangedCount: 0, unmatchedCount: 0, totalInFile: 0 }
  }

  const allMapped = applyMapping(rows, mapping)

  // Index existing shipments by tracking number (case-insensitive, trimmed)
  const existingByTracking = new Map()
  for (const ship of existingShipments) {
    if (ship.trackingNumber) {
      existingByTracking.set(ship.trackingNumber.trim().toLowerCase(), ship)
    }
  }

  const matched = []
  let unchangedCount = 0
  let unmatchedCount = 0

  for (const parsed of allMapped) {
    if (!parsed.trackingNumber) { unmatchedCount++; continue }

    const key = parsed.trackingNumber.trim().toLowerCase()
    const existing = existingByTracking.get(key)

    if (!existing) { unmatchedCount++; continue }

    // Diff: only include fields that actually changed
    const changes = {}
    for (const [field, newValue] of Object.entries(parsed)) {
      if (field === 'trackingNumber') continue // don't diff the match key
      const oldValue = existing[field] ?? ''
      const newStr = String(newValue ?? '').trim()
      const oldStr = String(oldValue ?? '').trim()
      if (newStr && newStr !== oldStr) {
        changes[field] = { oldValue: oldStr, newValue: newStr }
      }
    }

    if (Object.keys(changes).length > 0) {
      matched.push({ shipmentId: existing.id, trackingNumber: parsed.trackingNumber, changes })
    } else {
      unchangedCount++
    }
  }

  return {
    matched,
    unchangedCount,
    unmatchedCount,
    totalInFile: allMapped.length,
  }
}
