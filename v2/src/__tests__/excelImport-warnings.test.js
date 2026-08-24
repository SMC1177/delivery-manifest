import { describe, it, expect, vi } from 'vitest'
import { parseExcelFile, filterWarnedRows, compareHeaders } from '../utils/excelImport'

// Same xlsx mock harness as excelImport-remap.test.js — one convention, not two.
vi.mock('xlsx', () => ({
  read: vi.fn(),
  utils: { sheet_to_json: vi.fn() },
}))

import * as XLSX from 'xlsx'

const MAPPING = {
  patientName: 'Patient Name',
  trackingNumber: 'Tracking #',
  dateOfBirth: 'DOB',
  rxNumbers: 'Rx #',
  refillNumber: 'Refill #',
  date: 'Date',
}
const HEADERS = ['Patient Name', 'Tracking #', 'DOB', 'Rx #', 'Refill #', 'Date']

function row(overrides = {}) {
  return {
    'Patient Name': overrides.patientName ?? 'Alice',
    'Tracking #': overrides.trackingNumber ?? '',
    'DOB': overrides.dateOfBirth ?? '1985-03-06',
    'Rx #': overrides.rxNumbers ?? '6107113',
    'Refill #': overrides.refillNumber ?? '1',
    'Date': overrides.date ?? '2026-08-01',
  }
}

function prep(rows, headers = HEADERS) {
  XLSX.read.mockReset()
  XLSX.utils.sheet_to_json.mockReset()
  XLSX.read.mockReturnValue({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } })
  // parseExcelFile calls sheet_to_json twice: object rows (default) and header:1 raw arrays.
  XLSX.utils.sheet_to_json.mockImplementation((sheet, opts) =>
    opts && opts.header === 1
      ? [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ''))]
      : rows)
  return { arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)) }
}

// Six distinct patients "sharing" one rx — impossible for a real prescription; the
// exact 6000000/4000000/2000000 shape that produced 2,285 twin rows in production.
function genericRxRows() {
  return ['Ann A', 'Bob B', 'Cal C', 'Dee D', 'Eve E', 'Fay F'].map((name, i) =>
    row({ patientName: name, dateOfBirth: `196${i}-01-0${i + 1}`, rxNumbers: '6000000' }))
}

describe('parseExcelFile warnings', () => {
  it('flags an rx value shared by >=5 distinct patients, holding references into the parsed arrays', async () => {
    const rows = [...genericRxRows(), row({ patientName: 'Real Ray', rxNumbers: '5551234', dateOfBirth: '1970-05-05' })]
    const file = prep(rows)
    const result = await parseExcelFile(file, MAPPING, [])
    expect(result.warnings.repeatedRx).toHaveLength(1)
    const w = result.warnings.repeatedRx[0]
    expect(w.value).toBe('6000000')
    expect(w.patientCount).toBe(6)
    expect(w.rows).toHaveLength(6)
    for (const r of w.rows) {
      // Reference identity per seat seq 1356 — the SAME objects the writes consume, never copies.
      expect(result.shipments.includes(r)).toBe(true)
    }
  })

  it('does not flag an rx below the 5-distinct-patient threshold', async () => {
    const rows = [
      row({ patientName: 'A One', rxNumbers: '6107113', dateOfBirth: '1990-01-01' }),
      row({ patientName: 'B Two', rxNumbers: '6107113', dateOfBirth: '1991-02-02' }),
    ]
    const file = prep(rows)
    const result = await parseExcelFile(file, MAPPING, [])
    expect(result.warnings.repeatedRx).toEqual([])
  })

  it('flags an all-same-digit rx even on a single patient', async () => {
    const rows = [row({ patientName: 'Sol Solo', rxNumbers: '7777777' })]
    const file = prep(rows)
    const result = await parseExcelFile(file, MAPPING, [])
    expect(result.warnings.repeatedRx).toHaveLength(1)
    expect(result.warnings.repeatedRx[0].value).toBe('7777777')
    expect(result.shipments.includes(result.warnings.repeatedRx[0].rows[0])).toBe(true)
  })

  it('flags rows missing both patient name and dob, by reference', async () => {
    const rows = [
      row({ patientName: '', dateOfBirth: '', rxNumbers: '8887777', trackingNumber: '123456789012' }),
      row({ patientName: 'Keep Kay', rxNumbers: '4441234', dateOfBirth: '1980-08-08' }),
    ]
    const file = prep(rows)
    const result = await parseExcelFile(file, MAPPING, [])
    expect(result.warnings.blankIdentity.rows).toHaveLength(1)
    expect(result.shipments.includes(result.warnings.blankIdentity.rows[0])).toBe(true)
  })

  it('warning references reach into updates too, not only creates', async () => {
    const existing = [{
      id: 'x1', patientName: 'Ann A', dob: '1960-01-01', rxNumbers: ['6000000'],
      refillNumber: '1', trackingNumber: '', date: '2026-07-01', copay: 5,
    }]
    const rows = [...genericRxRows().map((r, i) =>
      i === 0 ? { ...r, 'Tracking #': '123456789015', 'Date': '2026-08-02' } : r)]
    const file = prep(rows)
    const result = await parseExcelFile(file, MAPPING, existing)
    expect(result.updates.length).toBeGreaterThan(0)
    const all = [...result.shipments, ...result.updates]
    const w = result.warnings.repeatedRx[0]
    expect(w.rows).toHaveLength(6)
    for (const r of w.rows) expect(all.includes(r)).toBe(true)
    expect(w.rows.some((r) => result.updates.includes(r))).toBe(true)
  })

  it('filterWarnedRows subtracts warned rows from BOTH arrays when excluded, keeps them when included', async () => {
    const existing = [{
      id: 'x1', patientName: 'Ann A', dob: '1960-01-01', rxNumbers: ['6000000'],
      refillNumber: '1', trackingNumber: '', date: '2026-07-01', copay: 5,
    }]
    const rows = [
      ...genericRxRows().map((r, i) =>
        i === 0 ? { ...r, 'Tracking #': '123456789015', 'Date': '2026-08-02' } : r),
      row({ patientName: '', dateOfBirth: '', rxNumbers: '8887777', trackingNumber: '123456789012' }),
      row({ patientName: 'Keep Kay', rxNumbers: '4441234', dateOfBirth: '1980-08-08' }),
    ]
    const file = prep(rows)
    const result = await parseExcelFile(file, MAPPING, existing)

    const excluded = filterWarnedRows(result, { repeatedRx: false, blankIdentity: false })
    expect(excluded.updates).toHaveLength(0)
    expect(excluded.shipments.some((s) => s.patientName === 'Keep Kay')).toBe(true)
    const allWarned = [...result.warnings.repeatedRx.flatMap((w) => w.rows), ...result.warnings.blankIdentity.rows]
    for (const w of allWarned) {
      expect(excluded.shipments.includes(w)).toBe(false)
      expect(excluded.updates.includes(w)).toBe(false)
    }

    const included = filterWarnedRows(result, { repeatedRx: true, blankIdentity: false })
    expect(included.updates).toHaveLength(result.updates.length)
    expect(included.shipments.length).toBe(result.shipments.length - result.warnings.blankIdentity.rows.length)
  })

  it('exposes the trimmed header row and compareHeaders reports added/removed', async () => {
    const file = prep([row({})])
    const result = await parseExcelFile(file, MAPPING, [])
    expect(result.headers).toEqual(HEADERS)
    expect(compareHeaders(['A', 'B', 'C'], ['B', 'C', 'D'])).toEqual({ added: ['D'], removed: ['A'] })
    expect(compareHeaders(HEADERS, HEADERS)).toEqual({ added: [], removed: [] })
  })
})

describe('update payload completeness (adversarial finding, 2026-08-24)', () => {
  const existing = [{
    id: 's1', patientName: 'John Doe', dob: '1990-01-01', rxNumbers: ['111222'],
    refillNumber: '1', trackingNumber: '123456789012', date: '2026-01-01',
  }]
  const fileRow = (date) => row({
    patientName: 'John Doe', dateOfBirth: '1990-01-01', rxNumbers: '111222',
    refillNumber: '1', trackingNumber: '123456789012', date,
  })

  it('a date-only change produces an update carrying the FULL identity, not just the changed field', async () => {
    const file = prep([fileRow('2026-02-01')])
    const result = await parseExcelFile(file, MAPPING, existing)
    expect(result.updates).toHaveLength(1)
    const u = result.updates[0]
    expect(u.shipmentId).toBe('s1')
    expect(u.date).toBe('2026-02-01')
    // RED at HEAD: the merge loop omits same-valued fields from the payload, and the
    // modal's update mapping then writes patientName:'' dob:'' rxNumbers:[] — wiping
    // stored identity on every partial change.
    expect(u.patientName).toBe('John Doe')
    expect(u.dateOfBirth).toBe('1990-01-01')
    expect((u.rxNumbers || []).join('|')).toBe('111222')
  })

  it('the repeated-rx threshold counts distinct patients FILE-WIDE, not only rows that write', async () => {
    // Ann A and Bob B already exist IDENTICALLY, so their file rows skip as
    // unchanged duplicates — but the FILE still shows 6 distinct patients on
    // one rx, which is the signal the operator is looking at.
    const preExisting = [
      {
        id: 'e1', patientName: 'Ann A', dob: '1960-01-01', rxNumbers: ['6000000'],
        refillNumber: '1', trackingNumber: '', date: '2026-08-01',
      },
      {
        id: 'e2', patientName: 'Bob B', dob: '1961-01-02', rxNumbers: ['6000000'],
        refillNumber: '1', trackingNumber: '', date: '2026-08-01',
      },
    ]
    const file = prep(genericRxRows())
    const result = await parseExcelFile(file, MAPPING, preExisting)
    // RED at HEAD: only the 4 written rows are counted (4 < 5), so no warning
    // is emitted and the remaining generic rows import unflagged.
    expect(result.warnings.repeatedRx).toHaveLength(1)
    const w = result.warnings.repeatedRx[0]
    expect(w.value).toBe('6000000')
    expect(w.patientCount).toBe(6)
    expect(w.rows.length).toBeGreaterThanOrEqual(4)
    const excluded = filterWarnedRows(result, {})
    for (const r of w.rows) {
      expect(excluded.shipments.includes(r)).toBe(false)
      expect(excluded.updates.includes(r)).toBe(false)
    }
  })

  it('a field the stored doc never had lands from the incoming row (new-column carry)', async () => {
    // The stored doc predates the facilityName field entirely — no key at all.
    const legacy = [{
      id: 's1', patientName: 'John Doe', dob: '1990-01-01', rxNumbers: ['111222'],
      refillNumber: '1', trackingNumber: '', date: '2026-07-01',
    }]
    const facilityHeaders = [...HEADERS, 'Facility']
    const incoming = { ...fileRow('2026-08-02'), 'Tracking #': '123456789015', Facility: 'St Mary' }
    const file = prep([incoming], facilityHeaders)
    XLSX.utils.sheet_to_json.mockImplementation((sheet, opts) =>
      opts && opts.header === 1
        ? [facilityHeaders, facilityHeaders.map((h) => incoming[h] ?? '')]
        : [incoming])
    const result = await parseExcelFile(file, { ...MAPPING, facilityName: 'Facility' }, legacy)
    expect(result.updates).toHaveLength(1)
    // RED at HEAD: stored === undefined skips the key, the payload omits it, and
    // the modal then writes facilityName '' — the customer's "new columns didn't
    // populate" symptom.
    expect(result.updates[0].facilityName).toBe('St Mary')
  })

  it('an all-same-character NON-digit rx on one patient is not flagged', async () => {
    const rows = [row({ patientName: 'Al Alpha', rxNumbers: 'AAAAAA', dateOfBirth: '1975-03-03' })]
    const file = prep(rows)
    const result = await parseExcelFile(file, MAPPING, [])
    // RED at HEAD: /^(.)\1+$/ over-matches; the spec says all-same-DIGIT only.
    expect(result.warnings.repeatedRx).toEqual([])
  })

  it('a stale incoming date keeps the STORED canonical date in the payload, not blank and not the stale value', async () => {
    const withNotes = [{
      id: 's1', patientName: 'John Doe', dob: '1990-01-01', rxNumbers: ['111222'],
      refillNumber: '1', trackingNumber: '', date: '2026-08-10', notes: 'a',
    }]
    // Older date than stored + a real change (notes) so the update fires.
    const staleRow = { ...fileRow('2026-08-01'), 'Tracking #': '123456789015' }
    const file = prep([staleRow], [...HEADERS, 'Notes'])
    XLSX.utils.sheet_to_json.mockImplementation((sheet, opts) =>
      opts && opts.header === 1
        ? [[...HEADERS, 'Notes'], [...HEADERS.map((h) => staleRow[h] ?? ''), 'b']]
        : [{ ...staleRow, Notes: 'b' }])
    const result = await parseExcelFile(file, { ...MAPPING, notes: 'Notes' }, withNotes)
    expect(result.updates).toHaveLength(1)
    const u = result.updates[0]
    // RED at HEAD: the dateRegressed skip omits the date key entirely, and the
    // modal then writes date: s.date || '' — wiping the canonical date, after
    // which the out-of-order guard never fires again.
    expect(u.date).toBe('2026-08-10')
    expect(u.notes).toBe('b')
  })

  it('a byte-identical row still produces ZERO updates (the changed gate survives the payload fix)', async () => {
    const file = prep([fileRow('2026-01-01')])
    const result = await parseExcelFile(file, MAPPING, existing)
    expect(result.updates).toHaveLength(0)
    expect(result.shipments).toHaveLength(0)
  })
})
