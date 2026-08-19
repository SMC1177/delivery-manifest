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
 * fillKey is determined by patientName + dateOfBirth + rxNumbers + refillNumber.
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe('parseExcelFile — pending-merge behaviour', () => {
  it('1. row with no tracking number lands in shipments and increments pendingCreated (not skippedNoTracking)', async () => {
    const { file, sheetToJson } = freshMocks()
    sheetToJson
      .mockReturnValueOnce([mockRow({ trackingNumber: '' })])
      .mockReturnValueOnce([['Patient Name', 'Tracking #', 'DOB', 'Rx #', 'Refill #', 'Date']])

    const result = await parseExcelFile(file, BASE_MAPPING, [])

    expect(result.shipments).toHaveLength(1)
    expect(result.shipments[0].trackingNumber).toBe('')
    expect(result.pendingCreated).toBe(1)
    expect(result.skippedNoTracking).toBe(0)
    expect(result.skippedDuplicate).toBe(0)
    expect(result.updates).toHaveLength(0)
  })

  it('2. persisted pending doc (id abc) + incoming tracking row with matching fill → update carrying shipmentId and tracking, trackingMerged=1, shipments empty', async () => {
    const { file, sheetToJson } = freshMocks()
    sheetToJson
      .mockReturnValueOnce([mockRow({ trackingNumber: '1ZTRACK' })])
      .mockReturnValueOnce([['Patient Name', 'Tracking #', 'DOB', 'Rx #', 'Refill #', 'Date']])

    const existing = [
      {
        id: 'abc',
        patientName: 'Alice',
        dob: '1990-01-01',          // Firestore field name is dob
        rxNumbers: ['RX1'],
        refillNumber: '1',
        trackingNumber: '',          // pending — no tracking
        date: '',
      },
    ]

    const result = await parseExcelFile(file, BASE_MAPPING, existing)

    expect(result.updates).toHaveLength(1)
    expect(result.updates[0].shipmentId).toBe('abc')
    expect(result.updates[0].trackingNumber).toBe('1ZTRACK')
    expect(result.trackingMerged).toBe(1)
    expect(result.shipments).toHaveLength(0)
    expect(result.needsReview).toBe(0)
  })

  it('3. incoming dateOfBirth differs from stored dob → NO merge, row becomes new shipment, trackingMerged=0', async () => {
    const { file, sheetToJson } = freshMocks()
    sheetToJson
      .mockReturnValueOnce([mockRow({ trackingNumber: '1ZTRACK', dateOfBirth: '1991-06-15' })])
      .mockReturnValueOnce([['Patient Name', 'Tracking #', 'DOB', 'Rx #', 'Refill #', 'Date']])

    const existing = [
      {
        id: 'abc',
        patientName: 'Alice',
        dob: '1990-01-01',          // different DOB
        rxNumbers: ['RX1'],
        refillNumber: '1',
        trackingNumber: '',
        date: '',
      },
    ]

    const result = await parseExcelFile(file, BASE_MAPPING, existing)

    expect(result.trackingMerged).toBe(0)
    expect(result.shipments).toHaveLength(1)
    expect(result.shipments[0].trackingNumber).toBe('1ZTRACK')
    expect(result.updates).toHaveLength(0)
  })

  it('4. TWO persisted pending docs sharing same patient/dob/rx/refill → incoming tracking row increments needsReview, produces NO update and NO new shipment', async () => {
    const { file, sheetToJson } = freshMocks()
    sheetToJson
      .mockReturnValueOnce([mockRow({ trackingNumber: '1ZTRACK' })])
      .mockReturnValueOnce([['Patient Name', 'Tracking #', 'DOB', 'Rx #', 'Refill #', 'Date']])

    const existing = [
      {
        id: 'abc',
        patientName: 'Alice',
        dob: '1990-01-01',
        rxNumbers: ['RX1'],
        refillNumber: '1',
        trackingNumber: '',
        date: '',
      },
      {
        id: 'def',
        patientName: 'Alice',
        dob: '1990-01-01',
        rxNumbers: ['RX1'],
        refillNumber: '1',
        trackingNumber: '',
        date: '',
      },
    ]

    const result = await parseExcelFile(file, BASE_MAPPING, existing)

    expect(result.needsReview).toBe(1)
    expect(result.updates).toHaveLength(0)
    expect(result.shipments).toHaveLength(0)
    expect(result.trackingMerged).toBe(0)
  })

  it('5. incoming row with empty rxNumbers AND empty refillNumber has no identity → needsReview, never inserted', async () => {
    const { file, sheetToJson } = freshMocks()
    sheetToJson
      .mockReturnValueOnce([mockRow({ trackingNumber: '1ZTRACK', rxNumbers: '', refillNumber: '' })])
      .mockReturnValueOnce([['Patient Name', 'Tracking #', 'DOB', 'Rx #', 'Refill #', 'Date']])

    const existing = [
      {
        id: 'abc',
        patientName: 'Alice',
        dob: '1990-01-01',
        rxNumbers: [],
        refillNumber: '',
        trackingNumber: '',
        date: '',
      },
    ]

    const result = await parseExcelFile(file, BASE_MAPPING, existing)

    // buildPatientFillKey returns null when both rx and refill are empty, so
    // the row has no identity.  Inserting it would re-insert it on every
    // subsequent import forever, because nothing could ever match it back —
    // so it is surfaced for review instead of silently duplicated.
    expect(result.needsReview).toBe(1)
    expect(result.shipments).toHaveLength(0)
    expect(result.updates).toHaveLength(0)
    expect(result.trackingMerged).toBe(0)
  })

  it('6. same tracking-less fill twice in one spreadsheet → exactly ONE shipment, not two', async () => {
    const { file, sheetToJson } = freshMocks()
    sheetToJson
      .mockReturnValueOnce([
        mockRow({ trackingNumber: '' }),
        mockRow({ trackingNumber: '' }),
      ])
      .mockReturnValueOnce([['Patient Name', 'Tracking #', 'DOB', 'Rx #', 'Refill #', 'Date']])

    const result = await parseExcelFile(file, BASE_MAPPING, [])

    expect(result.shipments).toHaveLength(1)
    expect(result.pendingCreated).toBe(1)
    expect(result.skippedDuplicate).toBe(1)
  })

  it('7. same fill twice: first without tracking, then with tracking → exactly ONE shipment carrying the tracking, NO update, no undefined shipmentId', async () => {
    const { file, sheetToJson } = freshMocks()
    sheetToJson
      .mockReturnValueOnce([
        mockRow({ trackingNumber: '' }),
        mockRow({ trackingNumber: '1ZTRACK' }),
      ])
      .mockReturnValueOnce([['Patient Name', 'Tracking #', 'DOB', 'Rx #', 'Refill #', 'Date']])

    const result = await parseExcelFile(file, BASE_MAPPING, [])

    expect(result.shipments).toHaveLength(1)
    expect(result.shipments[0].trackingNumber).toBe('1ZTRACK')
    expect(result.pendingCreated).toBe(1)
    expect(result.trackingMerged).toBe(1)
    expect(result.updates).toHaveLength(0)

    // Critical regression guard: no update object anywhere may have an
    // undefined shipmentId. (The historical bug: in-file pending rows had
    // no id, so merging tracking onto them produced updates[0].shipmentId
    // as undefined, which threw when the modal tried to build a doc ref.)
    for (const u of result.updates) {
      expect(typeof u.shipmentId).toBe('string')
    }
  })

  it('8a. incoming tracking matches existing doc composite key with NEWER date → update produced (pending-merge code must not alter this path)', async () => {
    const { file, sheetToJson } = freshMocks()
    sheetToJson
      .mockReturnValueOnce([mockRow({
        trackingNumber: '1ZABC',
        date: '2026-03-15',
      })])
      .mockReturnValueOnce([['Patient Name', 'Tracking #', 'DOB', 'Rx #', 'Refill #', 'Date']])

    const existing = [
      {
        id: 'existing-doc',
        patientName: 'Alice',
        trackingNumber: '1ZABC',
        rxNumbers: ['RX1'],
        refillNumber: '1',
        date: '2026-01-01',    // older
        dob: '1990-01-01',
      },
    ]

    const result = await parseExcelFile(file, BASE_MAPPING, existing)

    expect(result.updates).toHaveLength(1)
    expect(result.updates[0].shipmentId).toBe('existing-doc')
    expect(result.skippedDuplicate).toBe(0)
  })

  it('8b. incoming tracking matches existing doc composite key with older-or-equal date → skippedDuplicate (pending-merge code must not alter this path)', async () => {
    const { file, sheetToJson } = freshMocks()
    sheetToJson
      .mockReturnValueOnce([mockRow({
        trackingNumber: '1ZABC',
        date: '2026-01-01',
      })])
      .mockReturnValueOnce([['Patient Name', 'Tracking #', 'DOB', 'Rx #', 'Refill #', 'Date']])

    const existing = [
      {
        id: 'existing-doc',
        patientName: 'Alice',
        trackingNumber: '1ZABC',
        rxNumbers: ['RX1'],
        refillNumber: '1',
        date: '2026-03-15',    // newer
        dob: '1990-01-01',
      },
    ]

    const result = await parseExcelFile(file, BASE_MAPPING, existing)

    expect(result.skippedDuplicate).toBe(1)
    expect(result.updates).toHaveLength(0)
  })
})
