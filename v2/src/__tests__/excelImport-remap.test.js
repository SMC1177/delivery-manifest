import { describe, it, expect, vi } from 'vitest'
import { previewRemap } from '../utils/excelImport'

// ── Mock xlsx ────────────────────────────────────────────────────────
// previewRemap imports * as XLSX from 'xlsx'. Same harness the sibling
// excelImport tests use, so there is one convention rather than two.
vi.mock('xlsx', () => ({
  read: vi.fn(),
  utils: {
    sheet_to_json: vi.fn(),
  },
}))

// Re-import to get the mocked namespace
import * as XLSX from 'xlsx'

// ── Helpers ─────────────────────────────────────────────────────────

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

const BASE_MAPPING = {
  patientName: 'Patient Name',
  trackingNumber: 'Tracking #',
  dateOfBirth: 'DOB',
  rxNumbers: 'Rx #',
  refillNumber: 'Refill #',
  date: 'Date',
}

/** An incoming spreadsheet row, keyed by Excel header. */
function mockRow(overrides = {}) {
  return {
    'Patient Name': overrides.patientName ?? 'Alice',
    'Tracking #': overrides.trackingNumber ?? '1ZTRACK',
    'DOB': overrides.dateOfBirth ?? '1985-03-06',
    'Rx #': overrides.rxNumbers ?? '6107113',
    'Refill #': overrides.refillNumber ?? '1',
    'Date': overrides.date ?? '2026-08-01',
  }
}

/**
 * A stored shipment exactly as Firestore holds it: the birth date lives under
 * `dob` (never `dateOfBirth`, which is the parse-time name only), and
 * rxNumbers is an ARRAY. Both facts are what these tests exist to protect.
 */
function storedDoc(overrides = {}) {
  return {
    id: 'doc1',
    patientName: 'Alice',
    trackingNumber: '1ZTRACK',
    dob: '1985-03-06',
    rxNumbers: ['6107113'],
    carrier: 'ups',
    refillNumber: '1',
    date: '2026-08-01',
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('previewRemap — resolves the STORAGE key and preserves the stored type', () => {
  it('reports NO change when every incoming value already equals the stored value', async () => {
    const { file, sheetToJson } = freshMocks()
    sheetToJson.mockReturnValueOnce([mockRow()])

    const result = await previewRemap(file, BASE_MAPPING, [storedDoc()])

    // The stored doc holds the birth date under `dob`. Resolving the incoming
    // `dateOfBirth` against existing['dateOfBirth'] finds undefined, so the
    // old value reads as '' and an identical row is reported as changed on
    // every single run — inflating the change count and rewriting the field.
    expect(
      result.matched,
      'an identical row must produce no changes at all',
    ).toEqual([])
    expect(result.unchangedCount).toBe(1)
  })

  it('never emits a dateOfBirth key — the stored field is dob', async () => {
    const { file, sheetToJson } = freshMocks()
    // A genuinely different birth date SHOULD be reported — but under `dob`.
    sheetToJson.mockReturnValueOnce([mockRow({ dateOfBirth: '1991-06-15' })])

    const result = await previewRemap(file, BASE_MAPPING, [storedDoc()])
    const changes = result.matched[0]?.changes ?? {}

    // handleApplyRemap writes these keys verbatim into Firestore, so a
    // parse-time key here becomes a shadow field beside the real one.
    expect(
      Object.keys(changes),
      'the parse-time key must never reach the write payload',
    ).not.toContain('dateOfBirth')
    expect(
      changes.dob?.newValue,
      'the change must be keyed by the storage field',
    ).toBe('1991-06-15')
  })

  it('keeps rxNumbers an ARRAY in the change payload', async () => {
    const { file, sheetToJson } = freshMocks()
    sheetToJson.mockReturnValueOnce([mockRow({ rxNumbers: '6109999' })])

    const result = await previewRemap(file, BASE_MAPPING, [storedDoc()])
    const changes = result.matched[0]?.changes ?? {}

    // handleApplyRemap assigns changes[field].newValue straight into the
    // update. rxNumbers is an array field and the Rx search runs
    // where('rxNumbers','array-contains',q) — array-contains NEVER matches a
    // string, so a stringified value makes the row silently unfindable.
    expect(
      Array.isArray(changes.rxNumbers?.newValue),
      'rxNumbers must stay an array or array-contains can never match it',
    ).toBe(true)
  })
})
