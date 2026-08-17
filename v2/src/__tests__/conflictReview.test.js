// RED spec for v2/src/utils/conflictReview.js — that module does NOT exist yet,
// so this suite must fail to load (Cannot find module ...).
// Contract:
//   - IDENTITY_FIELDS = ['address', 'phone', 'patientName', 'dob']
//   - diffFlaggedRows({ incoming, lastAccepted }) -> [{ key, patientKey,
//       field, oldValue, newValue }] for each identity field that differs;
//       empty array when identical or no lastAccepted yet.
//   - seedLastAccepted(incoming) -> { patientKey: { address, phone,
//       patientName, dob } } built from the incoming rows (first import).
//   - applyDecision(conflict, 'keepBoth'|'keepOriginal'|'keepMostRecent')
//       -> { ...conflict, decision }
// PURE functions: no Firestore, no mutation of inputs.
import { describe, it, expect } from 'vitest'
import {
  IDENTITY_FIELDS,
  diffFlaggedRows,
  seedLastAccepted,
  applyDecision,
} from '../utils/conflictReview'

const incoming = [
  {
    patientName: 'Jane Smith',
    phone: '+1-555-0100',
    dob: '1980-01-01',
    address: '200 Maple Blvd',
    rxNumbers: ['RX-300'],
    trackingNumber: '1Z999AA1',
  },
  {
    patientName: 'Maria Garcia',
    phone: '+1-555-0200',
    dob: '1975-05-05',
    address: '88 Oak Ave',
    rxNumbers: ['RX-010'],
    trackingNumber: '789456123012',
  },
]

const lastAccepted = {
  'jane smith': {
    address: '123 Old St', // differs from incoming
    phone: '+1-555-0100',  // same
    patientName: 'Jane Smith',
    dob: '1980-01-01',
  },
}

describe('IDENTITY_FIELDS', () => {
  it('contains exactly address/phone/patientName/dob', () => {
    expect(IDENTITY_FIELDS).toEqual(['address', 'phone', 'patientName', 'dob'])
  })
})

describe('seedLastAccepted', () => {
  it('builds a last-accepted map keyed by normalized patient name', () => {
    const seeded = seedLastAccepted(incoming)
    expect(Object.keys(seeded).sort()).toEqual(['jane smith', 'maria garcia'])
    expect(seeded['jane smith']).toEqual({
      address: '200 Maple Blvd',
      phone: '+1-555-0100',
      patientName: 'Jane Smith',
      dob: '1980-01-01',
    })
  })
  it('does not mutate the incoming rows', () => {
    const rows = JSON.parse(JSON.stringify(incoming))
    seedLastAccepted(rows)
    expect(rows).toEqual(incoming)
  })
})

describe('diffFlaggedRows', () => {
  it('flags only identity fields that differ', () => {
    const flags = diffFlaggedRows({ incoming, lastAccepted })
    expect(flags).toHaveLength(1)
    expect(flags[0]).toMatchObject({
      patientKey: 'jane smith',
      field: 'address',
      oldValue: '123 Old St',
      newValue: '200 Maple Blvd',
    })
  })
  it('returns empty when no lastAccepted exists yet (first import)', () => {
    expect(diffFlaggedRows({ incoming, lastAccepted: {} })).toEqual([])
  })
  it('returns empty when identity matches exactly', () => {
    const flags = diffFlaggedRows({
      incoming: [incoming[1]],
      lastAccepted: { 'maria garcia': { address: '88 Oak Ave', phone: '+1-555-0200', patientName: 'Maria Garcia', dob: '1975-05-05' } },
    })
    expect(flags).toEqual([])
  })
})

describe('applyDecision', () => {
  const conflict = { patientKey: 'jane smith', field: 'address', oldValue: '123 Old St', newValue: '200 Maple Blvd' }
  it('records the decision without mutating the input conflict', () => {
    const decided = applyDecision(conflict, 'keepBoth')
    expect(decided.decision).toBe('keepBoth')
    expect(conflict.decision).toBeUndefined()
  })
  it('accepts all three decisions', () => {
    for (const d of ['keepBoth', 'keepOriginal', 'keepMostRecent']) {
      expect(applyDecision(conflict, d).decision).toBe(d)
    }
  })
})
