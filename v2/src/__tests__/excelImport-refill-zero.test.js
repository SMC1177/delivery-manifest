import { describe, it, expect, vi } from 'vitest'
import { parseExcelFile } from '../utils/excelImport'

// ── Mock xlsx ───────────────────────────────────────────────────────────────
// parseExcelFile imports * as XLSX from 'xlsx'. We mock the module so we
// control exactly what data flows into the function without creating real
// spreadsheets. Each test sets up the mock returns it needs.
vi.mock('xlsx', () => ({
  read: vi.fn(),
  utils: {
    sheet_to_json: vi.fn(),
  },
}))

// Re-import to get the mocked namespace
import * as XLSX from 'xlsx'

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Reset all XLSX mocks and return a fresh, prepped stub file + sheet_to_json mock */
function freshMocks() {
  XLSX.read.mockReset()
  XLSX.utils.sheet_to_json.mockReset()
  XLSX.read.mockReturnValue({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } })
  return {
    file: { arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)) },
    sheetToJson: XLSX.utils.sheet_to_json,
  }
}

/**
 * Minimal mapping: every field we use must be mapped so applyMapping
 * produces the exact values we expect.
 */
const BASE_MAPPING = {
  patientName: 'Patient Name',
  trackingNumber: 'Tracking #',
  dateOfBirth: 'DOB',
  rxNumbers: 'Rx #',
  refillNumber: 'Refill #',
  date: 'Date',
}

/**
 * Build a mock row object (keyed by Excel header) for a single shipment.
 * NB: the `??` nullish-coalescing defaults are load-bearing — `||` would
 * substitute the default '1' for the literal 0 under test and silently
 * destroy the premise of the RED case below.
 */
function mockRow(overrides = {}) {
  return {
    'Patient Name': overrides.patientName ?? 'Alice',
    'Tracking #': overrides.trackingNumber ?? '',
    'DOB': overrides.dateOfBirth ?? '1990-01-01',
    'Rx #': overrides.rxNumbers ?? 'RX1',
    'Refill #': overrides.refillNumber ?? '1',
    'Date': overrides.date ?? '',
  }
}

/**
 * Parse a single row and return the resulting shipment. The premise guard
 * (shipments length 1) exists so that a row which never reached the parser
 * cannot make the refill assertions pass or fail for an unrelated reason.
 */
async function parseOne(row, mapping = BASE_MAPPING) {
  const { file, sheetToJson } = freshMocks()
  sheetToJson
    .mockReturnValueOnce([row])
    .mockReturnValueOnce([['Patient Name', 'Tracking #', 'DOB', 'Rx #', 'Refill #', 'Date']])

  const result = await parseExcelFile(file, mapping, [])
  expect(result.shipments).toHaveLength(1)
  return result.shipments[0]
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('parseExcelFile — refill number zero handling', () => {
  it('1. numeric refill value 0 is preserved as "0" (RED — fails at HEAD)', async () => {
    const shipment = await parseOne(mockRow({ trackingNumber: '1ZTRACK', refillNumber: 0 }))
    expect(shipment.refillNumber).toBe('0')
  })

  it('2. string refill value "0" is preserved as "0"', async () => {
    const shipment = await parseOne(mockRow({ trackingNumber: '1ZTRACK', refillNumber: '0' }))
    expect(shipment.refillNumber).toBe('0')
  })

  it('3. numeric refill value 5 is preserved as "5"', async () => {
    const shipment = await parseOne(mockRow({ trackingNumber: '1ZTRACK', refillNumber: 5 }))
    expect(shipment.refillNumber).toBe('5')
  })

  it('4. unmapped refill column yields empty string', async () => {
    const noRefillMapping = { ...BASE_MAPPING }
    delete noRefillMapping.refillNumber
    const shipment = await parseOne(mockRow({ trackingNumber: '1ZTRACK', refillNumber: '3' }), noRefillMapping)
    expect(shipment.refillNumber).toBe('')
  })

  it('5. blank mapped refill cell yields empty string', async () => {
    const shipment = await parseOne(mockRow({ trackingNumber: '1ZTRACK', refillNumber: '' }))
    expect(shipment.refillNumber).toBe('')
  })
})
