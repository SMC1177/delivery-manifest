import * as XLSX from 'xlsx'
import { detectCarrier } from '../lib/carriers'

/**
 * Universal fields that shipments are stored with.
 *
 * The canonical list lives in ../constants/shipmentFields so that UI code
 * (settings toggles, shipment table columns, patient profile) can import the
 * field registry without pulling the xlsx parser into its bundle.
 *
 * Imported for local use by this module's mapping functions AND re-exported,
 * because existing callers import UNIVERSAL_FIELDS from this module.
 */
import { UNIVERSAL_FIELDS } from '../constants/shipmentFields'

export { UNIVERSAL_FIELDS }

/** Address sub-field keys for multi-column address concatenation */
export const ADDRESS_SUBFIELDS = ['address1', 'address2', 'city', 'state', 'zip']

/**
 * Fuzzy auto-mapping rules: [pattern, fieldKey]
 * Patterns are checked case-insensitively via .includes()
 */
const FUZZY_RULES = [
  // --- Specific rules first: first match wins, so these must precede the
  // --- general rules below or the general ones swallow the header.
  // Prescriber block MUST stay above the address sub-field rules: without it,
  // 'Prescriber Address1' matches the address1 rule and overwrites
  // 'Ship To Address1' as the shipping address.
  [/prescriber\s*last/i, 'prescriberLastName'],
  [/prescriber\s*first/i, 'prescriberFirstName'],
  [/prescriber\s*address/i, 'prescriberAddress1'],
  [/prescriber\s*city/i, 'prescriberCity'],
  [/prescriber\s*state/i, 'prescriberState'],
  // Effective Date and Refill Date get their own fields. Date Written and
  // Date Filled get their own fields too (operator ruling 2026-08-16: read when
  // present, leave empty when absent — blank is truth, flag rather than guess).
  // The canonical manifest date keeps resolving as before: it falls back to
  // dateFilled at apply time so existing behaviour is unchanged.
  [/effective\s*date/i, 'effectiveDate'],
  [/refill\s*date/i, 'refillDate'],
  [/date\s*filled|fill\s*date/i, 'dateFilled'],
  [/date\s*written/i, 'dateWritten'],
  // MUST precede the notes rule, which otherwise captures the drug description.
  [/dispensed\s*drug|drug\s*description/i, 'drugDescription'],
  [/drug\s*gpi|^gpi$/i, 'drugGpi'],
  [/^ndc$|ndc\s*code|^ndc\b/i, 'ndc'],
  // MUST precede the rxNumbers rule, whose pattern includes bare 'prescription'.
  [/prescription\s*length/i, 'prescriptionLength'],
  [/facility/i, 'facilityName'],
  [/quantity/i, 'quantityDispensed'],
  [/days\s*supply/i, 'daysSupply'],
  [/refills\s*authorized|refills\s*auth/i, 'refillsAuthorized'],
  [/refills\s*remaining|refills\s*left/i, 'refillsRemaining'],
  [/awp/i, 'awpCost'],
  [/copay/i, 'copayAmount'],
  [/order\s*description/i, 'orderDescription'],
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
      date: get('date') ? normalizeDate(get('date')) : (get('dateFilled') ? normalizeDate(get('dateFilled')) : ''),
      refillNumber: get('refillNumber') != null ? String(get('refillNumber')).trim() : '',
      notes: get('notes') ? String(get('notes')).trim() : '',

      // The extended pharmacy export. These are mapped in Settings exactly like
      // the ten above, but until now applyMapping had no slot for them, so
      // ImportPreviewModal's `?? ''` always fell through and every one landed on
      // the document as an empty string. Unmapped fields still resolve to ''
      // because get() returns undefined, so nothing changes for an org that
      // maps none of them.
      facilityName: get('facilityName') ? String(get('facilityName')).trim() : '',
      dateWritten: get('dateWritten') ? normalizeDate(get('dateWritten')) : '',
      dateFilled: get('dateFilled') ? normalizeDate(get('dateFilled')) : '',
      effectiveDate: get('effectiveDate') ? normalizeDate(get('effectiveDate')) : '',
      refillDate: get('refillDate') ? normalizeDate(get('refillDate')) : '',
      drugDescription: get('drugDescription') ? String(get('drugDescription')).trim() : '',
      drugGpi: get('drugGpi') ? String(get('drugGpi')).trim() : '',
      ndc: get('ndc') ? String(get('ndc')).trim() : '',
      // != null, not truthiness: a legitimate 0 quantity, 0 refills remaining or
      // $0 copay is real data. Truthiness turns it into '' — the same defect
      // already fixed once at refillNumber above.
      quantityDispensed: get('quantityDispensed') != null ? String(get('quantityDispensed')).trim() : '',
      daysSupply: get('daysSupply') != null ? String(get('daysSupply')).trim() : '',
      prescriptionLength: get('prescriptionLength') != null ? String(get('prescriptionLength')).trim() : '',
      refillsAuthorized: get('refillsAuthorized') != null ? String(get('refillsAuthorized')).trim() : '',
      refillsRemaining: get('refillsRemaining') != null ? String(get('refillsRemaining')).trim() : '',
      awpCost: get('awpCost') != null ? String(get('awpCost')).trim() : '',
      copayAmount: get('copayAmount') != null ? String(get('copayAmount')).trim() : '',
      deliveryMethod: get('deliveryMethod') ? String(get('deliveryMethod')).trim() : '',
      orderDescription: get('orderDescription') ? String(get('orderDescription')).trim() : '',
      prescriberFirstName: get('prescriberFirstName') ? String(get('prescriberFirstName')).trim() : '',
      prescriberLastName: get('prescriberLastName') ? String(get('prescriberLastName')).trim() : '',
      prescriberAddress1: get('prescriberAddress1') ? String(get('prescriberAddress1')).trim() : '',
      prescriberCity: get('prescriberCity') ? String(get('prescriberCity')).trim() : '',
      prescriberState: get('prescriberState') ? String(get('prescriberState')).trim() : '',
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

  // Index existing shipments by patient fill key → ARRAY of candidate docs.
  // An array is required: 6,913 colliding identity keys exist in live data,
  // so a Map to a single doc would silently drop all but one.  Stored docs
  // persist the birth date as 'dob' while incoming rows carry 'dateOfBirth',
  // hence the bridge below.
  const existingByFillKey = new Map()
  for (const ship of existingShipments) {
    const fillKey = buildPatientFillKey(ship.patientName, ship.dob || ship.dateOfBirth, ship.rxNumbers, ship.refillNumber)
    if (!fillKey) continue
    const arr = existingByFillKey.get(fillKey)
    if (arr) arr.push(ship)
    else existingByFillKey.set(fillKey, [ship])
  }

  let skippedNoTracking = 0
  let skippedDuplicate = 0
  let pendingCreated = 0
  let trackingMerged = 0
  let needsReview = 0
  const shipments = [] // new inserts
  const updates = []   // merged non-blank changes against existing docs

  for (const s of allMapped) {
    const fillKey = buildPatientFillKey(s.patientName, s.dateOfBirth, s.rxNumbers, s.refillNumber)
    if (!fillKey) {
      // No identity at all — surface for review, never insert.
      needsReview++
      continue
    }

    const incomingTracking = String(s.trackingNumber || '').trim()
    const candidates = existingByFillKey.get(fillKey) || []
    const qualifying = candidates.filter((doc) => {
      const docTracking = doc.trackingNumber == null ? '' : String(doc.trackingNumber).trim()
      // Same parcel when the stored tracking is blank (pending) or equal
      // IGNORING CASE; a different non-empty tracking number is a different
      // parcel.  Case is folded because every other tracking comparison here
      // folds it — buildDedupKey lowercases, and the SMS ledger dedupes
      // case-insensitively — and a case variant slipping through would insert
      // the very duplicate this guard exists to prevent.  Only the COMPARISON
      // folds case: the value written is whatever the incoming row supplied.
      return docTracking === '' || docTracking.toLowerCase() === incomingTracking.toLowerCase()
    })

    if (qualifying.length > 1) {
      // Two or more stored docs could equally claim this row, so there is no
      // honest way to choose.  Writing to one would strand the other as an
      // orphan nothing ever matches again — surface it instead of guessing.
      needsReview++
      continue
    }

    const match = qualifying[0]

    if (!match) {
      // No existing doc for this identity + tracking — brand-new shipment.
      // Append it to the key's array so a later row in this same file matches
      // it instead of inserting a second copy.
      shipments.push(s)
      if (!incomingTracking) pendingCreated++
      const arr = existingByFillKey.get(fillKey)
      if (arr) arr.push(s)
      else existingByFillKey.set(fillKey, [s])
      continue
    }

    // Merge — an incoming blank (undefined, null, '', []) must not overwrite
    // a populated stored value; '0' is data and is never blank.  Only keys
    // present on the incoming row are compared, and only against keys the
    // stored doc actually has (via the dob bridge).
    // Out-of-order protection.  A re-imported file can be OLDER than what is
    // already stored — a corrected export sent after a newer one — and
    // 'replace old with new' must not quietly become 'last file in order wins'.
    // This is NOT the removed date gate: an equal or newer date still updates
    // on any field change, and only a strict regression is refused.  Both sides
    // must be non-empty, because an unknown date is not an older one.
    // normalizeDate emits YYYY-MM-DD on every path, so this compare is
    // chronological.
    const incomingDate = s.date || ''
    const storedDate = match.date || ''
    // A strictly older date refuses THE DATE, never the row.
    //
    // Refusing the row was measured to discard a tracking number that arrived
    // on a corrected export — and because a tracking number goes from blank to a
    // number and never changes again, that number never returns on a later
    // import. The parcel ships, no message is ever sent, and nothing reports it.
    //
    // The guard's real job is untouched: the stale date itself is still refused
    // in the merge below, so the stored date stays canonical and an out-of-order
    // export still cannot become 'last file in order wins'. Every OTHER field on
    // the row is the pharmacy's current statement about that parcel and merges
    // normally.
    const dateRegressed = Boolean(incomingDate && storedDate && incomingDate < storedDate)

    let changed = false
    const merged = {}
    for (const k of Object.keys(s)) {
      // ONLY the canonical date. An earlier version also skipped dateFilled,
      // reasoning that it would otherwise reintroduce the regression by proxy.
      // It cannot: the fallback runs in applyMapping on the INCOMING row, so when
      // no Date column is mapped s.date already HOLDS the incoming dateFilled and
      // trips the check itself. With a Date column mapped the two are independent,
      // and skipping dateFilled threw away a fill date that had moved FORWARD —
      // current information, discarded because a different field was stale.
      if (dateRegressed && k === 'date') continue
      const incoming = s[k]
      const stored = k === 'dateOfBirth' ? (match.dob ?? match[k]) : match[k]
      if (stored === undefined) continue
      const blank = incoming === undefined || incoming === null || incoming === '' || (Array.isArray(incoming) && incoming.length === 0)
      if (blank) {
        // Preserve the populated stored value in the payload (idempotent write).
        if (stored !== '' && stored !== null) merged[k] = stored
        continue
      }
      let same
      if (k === 'rxNumbers') {
        const a = (Array.isArray(incoming) ? incoming : [incoming]).map(String).join('|')
        const b = (Array.isArray(stored) ? stored : [stored]).map(String).join('|')
        same = a === b
      } else {
        same = incoming === stored
      }
      if (!same) {
        merged[k] = incoming
        changed = true
      }
    }

    if (!changed) {
      skippedDuplicate++
      continue
    }

    const hadNoTracking = match.trackingNumber == null || String(match.trackingNumber).trim() === ''
    if (match.id) {
      updates.push({ shipmentId: match.id, ...merged })
    } else {
      // In-file row (inserted earlier in this same file, no doc id yet) —
      // fold the merged values in place; it is already in shipments.
      Object.assign(match, merged)
    }
    if (hadNoTracking && incomingTracking !== '') trackingMerged++
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
