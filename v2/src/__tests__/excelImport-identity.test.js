import { describe, it, expect, vi } from 'vitest'
import { parseExcelFile } from '../utils/excelImport'

// Same harness the pending-merge suite uses: xlsx is mocked, so no real
// spreadsheet is ever built and sheet_to_json is called twice — rows first,
// then the header row.
vi.mock('xlsx', () => ({
  read: vi.fn(),
  utils: { sheet_to_json: vi.fn() },
}))

import * as XLSX from 'xlsx'

const HEADERS = ['Patient Name', 'Tracking #', 'DOB', 'Rx #', 'Refill #', 'Date', 'Copay', 'Phone']

const MAPPING = {
  patientName: 'Patient Name',
  trackingNumber: 'Tracking #',
  dateOfBirth: 'DOB',
  rxNumbers: 'Rx #',
  refillNumber: 'Refill #',
  date: 'Date',
  copayAmount: 'Copay',
  phone: 'Phone',
}

function mockRow(o = {}) {
  return {
    'Patient Name': o.patientName ?? 'Alice',
    'Tracking #': o.trackingNumber ?? 'TRK-A',
    DOB: o.dateOfBirth ?? '1990-01-01',
    'Rx #': o.rxNumbers ?? 'RX1',
    'Refill #': o.refillNumber ?? '1',
    Date: o.date ?? '2026-01-01',
    Copay: o.copayAmount ?? '10',
    Phone: o.phone ?? '555-0100',
  }
}

// Firestore stores the birth date as `dob`, not `dateOfBirth` — the incoming
// mapped row uses the other name, and the identity has to bridge them.
function existingDoc(o = {}) {
  return {
    id: o.id ?? 'doc-1',
    patientName: o.patientName ?? 'Alice',
    dob: o.dob ?? '1990-01-01',
    rxNumbers: o.rxNumbers ?? ['RX1'],
    refillNumber: o.refillNumber ?? '1',
    trackingNumber: o.trackingNumber ?? 'TRK-A',
    date: o.date ?? '2026-01-01',
    copayAmount: o.copayAmount ?? '10',
    phone: o.phone ?? '555-0100',
    status: o.status ?? 'delivered',
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
 * The operator's rule: a shipment IS patientName + dob + rxNumbers + refillNumber,
 * and when anything in that row changes, the new row replaces the old.
 *
 * Four of these are genuine RED proofs that must fail at HEAD. The other four are
 * regression guards that already pass and must KEEP passing — they are labelled as
 * guards rather than dressed up as proofs, because a passing test called RED is
 * exactly the substitution that produced two false proofs on this project.
 */
describe('shipment identity — name + dob + rx + refill (Slice A)', () => {
  it('RED 1 — a tracked row whose copay changed but whose date did NOT must produce an update', async () => {
    const r = await run([mockRow({ copayAmount: '25' })], [existingDoc({ copayAmount: '10' })])

    // Premise, asserted so this cannot pass for the wrong reason: at HEAD the ONLY
    // thing that can produce an update is `newDate > oldDate`, so an unchanged date
    // routes the row into skippedDuplicate and the copay change is discarded.
    expect(r.skippedDuplicate, 'at HEAD the copay change is silently dropped as a duplicate').toBe(0)
    expect(r.updates).toHaveLength(1)
    expect(r.updates[0].shipmentId).toBe('doc-1')
    expect(r.updates[0].copayAmount).toBe('25')
  })

  it('RED 2 — a blank incoming cell must NOT overwrite a populated stored field', async () => {
    // The date advances so that HEAD reaches its update branch at all; the point of
    // the case is what the update CARRIES, not whether one happens.
    const r = await run(
      [mockRow({ phone: '', date: '2026-02-01' })],
      [existingDoc({ phone: '555-0100', date: '2026-01-01' })],
    )

    expect(r.updates).toHaveLength(1)
    expect(
      r.updates[0].phone,
      'a blank cell means no data supplied — it must not delete the stored number',
    ).toBe('555-0100')
  })

  it('RED 3 — an incoming numeric 0 DOES overwrite, because 0 is a value and not a blank', async () => {
    const r = await run([mockRow({ copayAmount: 0 })], [existingDoc({ copayAmount: '10' })])

    expect(r.updates).toHaveLength(1)
    expect(r.updates[0].copayAmount, 'zero is data; the blank guard must not swallow it').toBe('0')
  })

  it('RED 4 — a row that yields no identity key goes to needsReview and is never inserted', async () => {
    const r = await run([mockRow({ rxNumbers: '', refillNumber: '' })], [])

    expect(
      r.needsReview,
      'a row that cannot be identified must be surfaced, not silently inserted forever',
    ).toBe(1)
    expect(r.shipments, 'silently inserting an unidentifiable row duplicates it on every import').toHaveLength(0)
  })

  it('GUARD — a row that gains a tracking number updates the SAME document', async () => {
    const r = await run(
      [mockRow({ trackingNumber: 'TRK-A' })],
      [existingDoc({ trackingNumber: '' })],
    )

    expect(r.updates).toHaveLength(1)
    expect(r.updates[0].shipmentId).toBe('doc-1')
    expect(r.updates[0].trackingNumber).toBe('TRK-A')
    expect(r.shipments).toHaveLength(0)
  })

  it('GUARD — containment: a DIFFERENT non-empty tracking number inserts rather than overwriting', async () => {
    // Measured live: 6 Trident identity keys carry more than one tracking number on
    // the SAME date — one fill shipped as two parcels. Overwriting would delete the
    // second parcel's tracking, carrier and delivery status.
    const r = await run(
      [mockRow({ trackingNumber: 'TRK-B' })],
      [existingDoc({ trackingNumber: 'TRK-A' })],
    )

    expect(r.shipments, 'a second parcel is a new document, never an overwrite').toHaveLength(1)
    expect(r.shipments[0].trackingNumber).toBe('TRK-B')
    expect(r.updates, 'the first parcel must be left exactly as it was').toHaveLength(0)
  })

  it('RED 6 — tracking differing only in CASE is the same parcel, not a second one', async () => {
    // Every other tracking comparison in this codebase folds case first:
    // buildDedupKey does (trackingNumber || '').trim().toLowerCase(), and the
    // SMS ledger has a test named 'preserves the tracking number as written
    // while deduping case-insensitively'. The containment guard is the outlier,
    // so a case variant currently inserts a duplicate and strands the original.
    const r = await run(
      [mockRow({ trackingNumber: 'TRK-A', copayAmount: '25' })],
      [existingDoc({ trackingNumber: 'trk-a', copayAmount: '10' })],
    )

    expect(r.shipments, 'a case variant is the same parcel, so nothing may be inserted').toHaveLength(0)
    expect(r.updates).toHaveLength(1)
    expect(r.updates[0].shipmentId).toBe('doc-1')
    expect(r.updates[0].copayAmount).toBe('25')
    // Dedupe case-insensitively, but store the value exactly as supplied.
    expect(
      r.updates[0].trackingNumber,
      'the comparison folds case; the stored value must not be rewritten by it',
    ).toBe('TRK-A')
  })

  it('GUARD — a byte-identical re-import produces no update at all', async () => {
    // Without this, every daily import would rewrite all 20,739 Trident documents.
    // The operator's rule is replace-when-something-CHANGES.
    const r = await run([mockRow()], [existingDoc()])

    expect(r.updates, 'nothing changed, so nothing may be written').toHaveLength(0)
    expect(r.shipments).toHaveLength(0)
  })

  it('RED 5 — once the update happens at all, its payload carries no app-owned delivery state', async () => {
    const r = await run([mockRow({ copayAmount: '25' })], [existingDoc({ status: 'delivered' })])

    expect(r.updates).toHaveLength(1)
    expect(
      r.updates[0].status,
      'status is owned by the app, not the spreadsheet — the import must never carry it',
    ).toBeUndefined()
  })
})
