import { describe, it, expect, vi } from 'vitest'
import { parseExcelFile } from '../utils/excelImport'

// Same harness as excelImport-identity.test.js: xlsx is mocked, so no real
// spreadsheet is built and sheet_to_json is called twice — rows first, then the
// header row.
vi.mock('xlsx', () => ({
  read: vi.fn(),
  utils: { sheet_to_json: vi.fn() },
}))

import * as XLSX from 'xlsx'

const HEADERS = ['Patient Name', 'Tracking #', 'DOB', 'Rx #', 'Refill #', 'Date', 'Phone']

const MAPPING = {
  patientName: 'Patient Name',
  trackingNumber: 'Tracking #',
  dateOfBirth: 'DOB',
  rxNumbers: 'Rx #',
  refillNumber: 'Refill #',
  date: 'Date',
  phone: 'Phone',
}

function mockRow(o = {}) {
  return {
    'Patient Name': o.patientName ?? 'Alice',
    'Tracking #': o.trackingNumber ?? '',
    DOB: o.dateOfBirth ?? '1990-01-01',
    'Rx #': o.rxNumbers ?? 'RX1',
    'Refill #': o.refillNumber ?? '1',
    Date: o.date ?? '2026-08-17',
    Phone: o.phone ?? '555-0100',
  }
}

// Firestore stores the birth date as `dob`; the mapped row calls it dateOfBirth.
function existingDoc(o = {}) {
  return {
    id: o.id ?? 'doc-1',
    patientName: o.patientName ?? 'Alice',
    dob: o.dob ?? '1990-01-01',
    rxNumbers: o.rxNumbers ?? ['RX1'],
    refillNumber: o.refillNumber ?? '1',
    trackingNumber: o.trackingNumber ?? '',
    date: o.date ?? '2026-08-17',
    phone: o.phone ?? '555-0100',
    status: o.status ?? 'pending',
  }
}

async function run(rows, existing) {
  XLSX.read.mockReset()
  XLSX.utils.sheet_to_json.mockReset()
  XLSX.read.mockReturnValue({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } })
  const file = { arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)) }
  XLSX.utils.sheet_to_json.mockReturnValueOnce(rows).mockReturnValueOnce([HEADERS])
  return parseExcelFile(file, MAPPING, existing)
}

/**
 * THE DEFECT. The matching loop carries an out-of-order guard:
 *
 *   if (incomingDate && storedDate && incomingDate < storedDate) {
 *     skippedDuplicate++; continue
 *   }
 *
 * The `continue` discards the WHOLE ROW. The guard's legitimate job is to keep
 * the canonical date monotonic across re-imports, but it also throws away every
 * other field the row carried — including a tracking number.
 *
 * WHY THAT IS UNRECOVERABLE, and not merely untidy. The operator's rule is that
 * a tracking number goes from blank to a number and never changes again. So a
 * number discarded here never arrives on a later import: the parcel ships, the
 * row stays blank, no SMS ever fires, and nothing in the system says so.
 *
 * The rule these tests pin: a date regression refuses the DATE, and only the
 * date. Every other field on the row still merges.
 */
describe('a date regression refuses the date, not the row', () => {
  it('RED — an earlier date must not discard the tracking number that arrived with it', async () => {
    const r = await run(
      [mockRow({ date: '2026-08-15', trackingNumber: 'T9' })],
      [existingDoc({ date: '2026-08-17', trackingNumber: '' })],
    )

    // `?? {}` is deliberate. At HEAD `updates` is empty, and reading
    // `updates[0].trackingNumber` directly would throw a TypeError — a failure
    // that proves the test never ran rather than that the code is wrong. This
    // project has already shipped one false red of exactly that shape. With the
    // fallback the assertion actually executes and fails on its own comparison.
    const applied = r.updates[0] ?? {}

    expect(
      applied.trackingNumber,
      'a date-regressed row must still accept its tracking number — otherwise the parcel ships, no text is ever sent, and the number never arrives again',
    ).toBe('T9')

    expect(r.updates, 'the row must produce an update, not be thrown away').toHaveLength(1)
    expect(
      r.skippedDuplicate,
      'only the date is stale; the row is not a duplicate',
    ).toBe(0)

    // The guard's real job survives: the stale date itself is still refused.
    expect(
      applied.date,
      'the stored date stays canonical — an older export must not regress it',
    ).not.toBe('2026-08-15')
  })

  it('GUARD — a stale export carrying nothing new must still write nothing', async () => {
    // Same regression, but the tracking number already matches, so once the date
    // is refused there is genuinely nothing left to apply. This passes at HEAD
    // and must keep passing: it is what stops the fix turning "refuse the date"
    // into "write the stale date".
    const r = await run(
      [mockRow({ date: '2026-08-15', trackingNumber: 'T1' })],
      [existingDoc({ date: '2026-08-17', trackingNumber: 'T1' })],
    )

    expect(
      r.updates,
      'the date is refused and nothing else differs, so there is nothing to write',
    ).toHaveLength(0)
    expect(r.skippedDuplicate).toBe(1)
  })

  it('GUARD — a LATER date still updates normally', async () => {
    // The fix must not make the guard fire on dates that move forward, which is
    // the ordinary case every daily import takes.
    const r = await run(
      [mockRow({ date: '2026-08-19', trackingNumber: 'T5' })],
      [existingDoc({ date: '2026-08-17', trackingNumber: '' })],
    )

    expect(r.updates).toHaveLength(1)
    expect(r.updates[0].trackingNumber).toBe('T5')
    expect(r.updates[0].date, 'a forward date is not a regression and must apply').toBe('2026-08-19')
  })
})
