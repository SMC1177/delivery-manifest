import * as XLSX from 'xlsx'
import { detectCarrier } from '../lib/carriers'

/**
 * Column header mapping — case-insensitive, supports wildcard (*) matching.
 * Each entry: [pattern, fieldName]
 */
const COLUMN_MAP = [
  ['customer name', 'patientName'],
  ['patient name', 'patientName'],
  ['customer phone', 'phone'],
  ['phone', 'phone'],
  ['customer birthd', 'dateOfBirth'],
  ['dob', 'dateOfBirth'],
  ['date of birth', 'dateOfBirth'],
  ['rx number', 'rxNumbers'],
  ['rx #', 'rxNumbers'],
  ['prescription', 'rxNumbers'],
  ['shipment tracking', 'trackingNumber'],
  ['tracking number', 'trackingNumber'],
  ['tracking #', 'trackingNumber'],
  ['ship to', 'address'],
  ['address', 'address'],
  ['date written', 'date'],
  ['date dispensed', 'date'],
  ['date filled', 'date'],
  ['dispensed drug', 'notes'],
  ['drug description', 'notes'],
]

/**
 * Match a column header to a field name using case-insensitive prefix matching.
 * e.g. "Customer Birthday" matches "customer birthd"
 */
function matchColumn(header) {
  const h = (header || '').toLowerCase().trim()
  for (const [pattern, field] of COLUMN_MAP) {
    if (h === pattern || h.startsWith(pattern)) return field
  }
  return null
}

/**
 * Build a mapping of column index → field name from the header row.
 */
function buildColumnMapping(headers) {
  const mapping = {}
  for (let i = 0; i < headers.length; i++) {
    const field = matchColumn(headers[i])
    if (field && !mapping[field]) {
      mapping[field] = i
    }
  }
  return mapping
}

/**
 * Normalize a date value from Excel into YYYY-MM-DD string.
 * Handles: Excel serial numbers, MM/DD/YYYY strings, YYYY-MM-DD strings, Date objects.
 */
export function normalizeDate(value) {
  if (value == null || value === '') return ''

  // Date object
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return ''
    return value.toISOString().slice(0, 10)
  }

  // Number — Excel serial date
  if (typeof value === 'number') {
    const ms = (value - 25569) * 86400 * 1000
    const d = new Date(ms)
    if (isNaN(d.getTime())) return ''
    return d.toISOString().slice(0, 10)
  }

  const str = String(value).trim()

  // YYYY-MM-DD pass through
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str

  // MM/DD/YYYY
  const mdyMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (mdyMatch) {
    const [, m, d, y] = mdyMatch
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }

  // Numeric string — Excel serial as string
  if (/^\d+$/.test(str)) {
    return normalizeDate(Number(str))
  }

  return ''
}

/**
 * Detect carrier from tracking number.
 * Extends the app's existing detectCarrier with a fallback.
 */
export function detectCarrierFromTracking(trackingNumber) {
  if (!trackingNumber) return 'other'
  const tn = String(trackingNumber).trim()
  return detectCarrier(tn) || 'other'
}

/**
 * Parse Rx numbers from a cell value.
 * Splits on comma, semicolon, or newline.
 */
function parseRxNumbers(value) {
  if (!value) return []
  const str = String(value).trim()
  if (!str) return []
  return str
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Map raw spreadsheet rows to shipment objects using detected column mapping.
 */
export function mapRowsToShipments(rows, headers) {
  const mapping = buildColumnMapping(headers)
  const shipments = []

  for (const row of rows) {
    const get = (field) => {
      const idx = mapping[field]
      if (idx == null) return undefined
      return row[idx]
    }

    const trackingRaw = get('trackingNumber')
    const tracking = trackingRaw ? String(trackingRaw).trim() : ''

    const patientName = get('patientName') ? String(get('patientName')).trim() : ''
    const phone = get('phone') ? String(get('phone')).trim() : ''
    const dateOfBirth = get('dateOfBirth') ? normalizeDate(get('dateOfBirth')) : ''
    const address = get('address') ? String(get('address')).trim() : ''
    const date = get('date') ? normalizeDate(get('date')) : ''
    const notes = get('notes') ? String(get('notes')).trim() : ''
    const rxNumbers = parseRxNumbers(get('rxNumbers'))
    const carrier = detectCarrierFromTracking(tracking)

    shipments.push({
      patientName,
      phone,
      dateOfBirth,
      address,
      rxNumbers,
      trackingNumber: tracking,
      carrier,
      date,
      notes,
    })
  }

  return shipments
}

/**
 * Parse an Excel file (.xlsx/.xls) and return mapped shipments.
 *
 * @param {File} file - The uploaded file
 * @param {string[]} existingTrackingNumbers - Tracking numbers already in Firestore (for dedup)
 * @returns {Promise<ParsedImportResult>}
 */
export async function parseExcelFile(file, existingTrackingNumbers = []) {
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: 'array' })

  const sheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]

  // Get raw data as array of arrays (preserves column order)
  const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })

  if (rawData.length < 2) {
    return {
      shipments: [],
      skippedNoTracking: 0,
      skippedDuplicate: 0,
      totalRows: 0,
      preview: [],
    }
  }

  const headers = rawData[0].map((h) => String(h))
  const dataRows = rawData.slice(1).filter((row) => row.some((cell) => cell !== ''))

  const allMapped = mapRowsToShipments(dataRows, headers)
  const existingSet = new Set(existingTrackingNumbers.map((t) => t.toLowerCase()))

  let skippedNoTracking = 0
  let skippedDuplicate = 0
  const shipments = []

  for (const s of allMapped) {
    if (!s.trackingNumber) {
      skippedNoTracking++
      continue
    }
    if (existingSet.has(s.trackingNumber.toLowerCase())) {
      skippedDuplicate++
      continue
    }
    shipments.push(s)
  }

  return {
    shipments,
    skippedNoTracking,
    skippedDuplicate,
    totalRows: allMapped.length,
    preview: shipments.slice(0, 5),
  }
}
