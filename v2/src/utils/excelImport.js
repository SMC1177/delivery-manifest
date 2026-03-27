import * as XLSX from 'xlsx'
import { detectCarrier } from '../lib/carriers'

/** Universal fields that shipments are stored with */
export const UNIVERSAL_FIELDS = [
  { key: 'patientName', label: 'Patient Name', required: true },
  { key: 'phone', label: 'Phone', required: false },
  { key: 'dateOfBirth', label: 'Date of Birth', required: false },
  { key: 'rxNumbers', label: 'RX Numbers', required: false },
  { key: 'trackingNumber', label: 'Tracking #', required: true },
  { key: 'address', label: 'Address', required: false, isAddress: true },
  { key: 'carrier', label: 'Carrier', required: false },
  { key: 'date', label: 'Date', required: false },
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
  [/date\s*filled|fill\s*date|dispensed\s*date|date\s*written|date\s*dispensed/i, 'date'],
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
 * Parse an Excel file using a saved column mapping.
 *
 * @param {File} file
 * @param {Record<string, string | string[]>} mapping - column mapping
 * @param {string[]} existingTrackingNumbers - for dedup
 * @returns {Promise<ParsedImportResult>}
 */
export async function parseExcelFile(file, mapping, existingTrackingNumbers = []) {
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: 'array' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]

  // Get rows as objects keyed by header
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  if (rows.length === 0) {
    return { shipments: [], skippedNoTracking: 0, skippedDuplicate: 0, totalRows: 0, preview: [], unmappedColumns: [] }
  }

  // Get all headers
  const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
  const allHeaders = rawData[0].map((h) => String(h).trim())

  const allMapped = applyMapping(rows, mapping)
  const existingSet = new Set(existingTrackingNumbers.map((t) => t.toLowerCase()))
  const unmappedColumns = getUnmappedColumns(allHeaders, mapping)

  let skippedNoTracking = 0
  let skippedDuplicate = 0
  const shipments = []

  for (const s of allMapped) {
    if (!s.trackingNumber) { skippedNoTracking++; continue }
    if (existingSet.has(s.trackingNumber.toLowerCase())) { skippedDuplicate++; continue }
    shipments.push(s)
  }

  return {
    shipments,
    skippedNoTracking,
    skippedDuplicate,
    totalRows: allMapped.length,
    preview: shipments.slice(0, 5),
    unmappedColumns,
  }
}
