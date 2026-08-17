// RED spec for v2/src/utils/patientGrouping.js — that module does NOT exist yet,
// so this suite must fail to load (Cannot find module '../utils/patientGrouping').
// The assertions below are the acceptance contract the implementation must satisfy,
// written against the REAL persisted shipment shape (see ImportPreviewModal: fields
// are patientName, patientNameLower, phone, dob, address, rxNumbers, trackingNumber,
// carrier, date, refillNumber, notes, facilityName, dateWritten, dateFilled,
// effectiveDate, refillDate, drugDescription, drugGpi, ndc, quantityDispensed,
// daysSupply, prescriptionLength, refillsAuthorized, refillsRemaining, awpCost,
// copayAmount, deliveryMethod, orderDescription, prescriberFirstName,
// prescriberLastName, prescriberAddress1, prescriberCity, prescriberState).
// Contract:
//   - normalizePatientKey(name)      -> trimmed+lowercased key ('' for blank/null/undefined)
//   - groupShipmentsByPatient(list)  -> [{ key, patientName, shipments }] sorted by key,
//                                       case variants merged, blank names dropped
//   - buildPatientRow(group)         -> { key, patientName, phone, dob, address,
//                                         shipmentCount, firstShipped, lastShipped }
//   - buildProfileSections(group)    -> { prescriptions, addresses, insurance,
//                                         facilityNames, notes }
// IMPORT-SAFETY: pure view/derivation over existing docs — nothing written back.
import { describe, it, expect } from 'vitest'

import {
  normalizePatientKey,
  groupShipmentsByPatient,
  buildPatientRow,
  buildProfileSections,
} from '../utils/patientGrouping'

// ---------------------------------------------------------------------------
// Fixtures (shape matches the real persisted shipment docs)
// ---------------------------------------------------------------------------

const janeShipments = [
  { id: 's1', patientName: 'Jane Smith', patientNameLower: 'jane smith', phone: '+1-555-0100', dob: '1980-01-01', date: '2025-03-10', rxNumbers: ['RX-100'], address: '100 Main St', facilityName: 'Northside Pharmacy', awpCost: '100.00', copayAmount: '10.00', ndc: 'N1', quantityDispensed: '30', daysSupply: '30', prescriberFirstName: 'Ann', prescriberLastName: 'Lee', prescriberAddress1: '1 Med Dr', prescriberCity: 'Austin', prescriberState: 'TX', notes: 'Leave at door' },
  { id: 's2', patientName: 'jane smith', patientNameLower: 'jane smith', phone: '+1-555-0100', dob: '1980-01-01', date: '2025-05-01', rxNumbers: ['RX-200', 'RX-201'], address: '55 Oak Ave', facilityName: 'Dr. Chen Office', awpCost: '200.00', copayAmount: '20.00', ndc: 'N2', quantityDispensed: '60', daysSupply: '30', prescriberFirstName: 'Bob', prescriberLastName: 'Zhu', prescriberAddress1: '2 Care Ln', prescriberCity: 'Dallas', prescriberState: 'TX', notes: 'Call before delivery' },
  { id: 's3', patientName: 'jane SMITH', patientNameLower: 'jane smith', phone: '+1-555-0100', dob: '1980-01-01', date: '2025-06-15', rxNumbers: ['RX-300'], address: '200 Maple Blvd', facilityName: 'Northside Pharmacy', awpCost: '300.00', copayAmount: '30.00', ndc: 'N3', quantityDispensed: '90', daysSupply: '30', prescriberFirstName: 'Ann', prescriberLastName: 'Lee', prescriberAddress1: '1 Med Dr', prescriberCity: 'Austin', prescriberState: 'TX', notes: '' },
  { id: 's7', patientName: 'Jane Smith', patientNameLower: 'jane smith', phone: '+1-555-0100', dob: '1980-01-01', date: '2025-01-20', rxNumbers: ['RX-700'], address: '100 Main St', facilityName: 'Northside Pharmacy', awpCost: '70.00', copayAmount: '7.00', ndc: 'N7', quantityDispensed: '30', daysSupply: '30', prescriberFirstName: 'Ann', prescriberLastName: 'Lee', prescriberAddress1: '1 Med Dr', prescriberCity: 'Austin', prescriberState: 'TX', notes: 'Fragile' },
  { id: 's8', patientName: 'JANE SMITH', patientNameLower: 'jane smith', phone: '+1-555-0100', dob: '1980-01-01', date: '2024-12-05', rxNumbers: ['RX-800'], address: '12 Park Lane', facilityName: 'City Drug', awpCost: '80.00', copayAmount: '8.00', ndc: 'N8', quantityDispensed: '30', daysSupply: '30', prescriberFirstName: 'Cal', prescriberLastName: 'Ngo', prescriberAddress1: '3 Rd Ave', prescriberCity: 'Houston', prescriberState: 'TX', notes: 'Ring bell' },
  { id: 's9', patientName: 'Jane Smith', patientNameLower: 'jane smith', phone: '+1-555-0100', dob: '1980-01-01', date: '2025-04-05', rxNumbers: ['RX-900'], address: '300 Cedar Rd', facilityName: 'Northside Pharmacy', awpCost: '90.00', copayAmount: '9.00', ndc: 'N9', quantityDispensed: '30', daysSupply: '30', prescriberFirstName: 'Ann', prescriberLastName: 'Lee', prescriberAddress1: '1 Med Dr', prescriberCity: 'Austin', prescriberState: 'TX', notes: '' },
]

const bobShipment = {
  id: 's4', patientName: 'Bob Jones', patientNameLower: 'bob jones', phone: '+1-555-0200', dob: '1975-05-05', date: '2025-04-20', rxNumbers: ['RX-400'], address: '7 Elm St', facilityName: 'Sunrise Care Center', awpCost: '40.00', copayAmount: '4.00', ndc: 'N4', quantityDispensed: '30', daysSupply: '30', prescriberFirstName: 'Dan', prescriberLastName: 'Kim', prescriberAddress1: '4 Ln', prescriberCity: 'San Antonio', prescriberState: 'TX', notes: 'Signature required',
}

const blankNameShipments = [
  { id: 's5', patientName: '   ', patientNameLower: '', date: '2025-02-01', rxNumbers: ['RX-500'], address: 'X', facilityName: 'Unknown', notes: '' },
  { id: 's6', patientName: '', patientNameLower: '', date: '2025-02-02', rxNumbers: ['RX-600'], address: 'Y', facilityName: 'Unknown', notes: '' },
  { id: 'sA', patientName: null, patientNameLower: null, date: '2025-02-03', rxNumbers: ['RX-6A'], address: 'Z', facilityName: 'Unknown', notes: '' },
]

const janeGroup = { key: 'jane smith', patientName: 'jane SMITH', shipments: janeShipments }
const bobGroup = { key: 'bob jones', patientName: 'Bob Jones', shipments: [bobShipment] }

// ---------------------------------------------------------------------------
// normalizePatientKey
// ---------------------------------------------------------------------------

describe('normalizePatientKey', () => {
  it('trims surrounding whitespace and lowercases', () => {
    expect(normalizePatientKey('  Jane Smith  ')).toBe('jane smith')
  })

  it('maps case variants of the same name to one key', () => {
    expect(normalizePatientKey('Jane Smith')).toBe(normalizePatientKey('jane smith'))
    expect(normalizePatientKey('Jane Smith')).toBe(normalizePatientKey('JANE SMITH'))
  })

  it('returns an empty string for blank or missing names', () => {
    expect(normalizePatientKey('')).toBe('')
    expect(normalizePatientKey('   ')).toBe('')
    expect(normalizePatientKey(null)).toBe('')
    expect(normalizePatientKey(undefined)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// groupShipmentsByPatient
// ---------------------------------------------------------------------------

describe('groupShipmentsByPatient', () => {
  it('merges case variants of the same patient into a single group', () => {
    const groups = groupShipmentsByPatient(janeShipments)
    expect(groups).toHaveLength(1)
    const group = groups[0]
    expect(group.key).toBe('jane smith')
    expect(group.patientName).toBe('jane SMITH') // most-recent shipment's case variant
    expect(group.shipments.map((s) => s.id)).toEqual(
      expect.arrayContaining(['s1', 's2', 's3', 's7', 's8', 's9'])
    )
  })

  it('drops shipments with blank or missing patient names', () => {
    const groups = groupShipmentsByPatient([
      ...janeShipments,
      bobShipment,
      ...blankNameShipments,
    ])
    expect(groups).toHaveLength(2)
    const ids = groups.flatMap((g) => g.shipments.map((s) => s.id))
    expect(ids).not.toContain('s5')
    expect(ids).not.toContain('s6')
    expect(ids).not.toContain('sA')
    for (const group of groups) {
      expect(group.key).not.toBe('')
    }
  })

  it('sorts groups by normalized key', () => {
    const groups = groupShipmentsByPatient([
      { id: 'm', patientName: 'Mike Tyson', date: '2025-01-01', rxNumbers: [] },
      { id: 'z', patientName: 'Zoe Adams', date: '2025-01-01', rxNumbers: [] },
      { id: 'a', patientName: 'Alice Brown', date: '2025-01-01', rxNumbers: [] },
    ])
    expect(groups.map((g) => g.key)).toEqual(['alice brown', 'mike tyson', 'zoe adams'])
  })

  it('returns an empty array for an empty input', () => {
    expect(groupShipmentsByPatient([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// buildPatientRow
// ---------------------------------------------------------------------------

describe('buildPatientRow', () => {
  it('summarizes a group into a row with identity + date span', () => {
    expect(buildPatientRow(janeGroup)).toEqual({
      key: 'jane smith',
      patientName: 'jane SMITH',
      phone: '+1-555-0100',
      dob: '1980-01-01',
      address: '200 Maple Blvd', // most recent shipment's address
      shipmentCount: 6,
      firstShipped: '2024-12-05',
      lastShipped: '2025-06-15',
    })
  })

  it('handles a single-shipment group', () => {
    expect(buildPatientRow(bobGroup)).toEqual({
      key: 'bob jones',
      patientName: 'Bob Jones',
      phone: '+1-555-0200',
      dob: '1975-05-05',
      address: '7 Elm St',
      shipmentCount: 1,
      firstShipped: '2025-04-20',
      lastShipped: '2025-04-20',
    })
  })
})

// ---------------------------------------------------------------------------
// buildProfileSections
// ---------------------------------------------------------------------------

describe('buildProfileSections', () => {
  it('lists prescriptions newest-first (date desc) with rx numbers', () => {
    const { prescriptions } = buildProfileSections(janeGroup)
    expect(prescriptions).toEqual([
      { date: '2025-06-15', rxNumbers: ['RX-300'] },
      { date: '2025-05-01', rxNumbers: ['RX-200', 'RX-201'] },
      { date: '2025-04-05', rxNumbers: ['RX-900'] },
      { date: '2025-03-10', rxNumbers: ['RX-100'] },
      { date: '2025-01-20', rxNumbers: ['RX-700'] },
      { date: '2024-12-05', rxNumbers: ['RX-800'] },
    ])
  })

  it('builds Facility/Home/MD addresses with default = most recent + distinct history', () => {
    const { addresses } = buildProfileSections(janeGroup)
    expect(addresses.Facility).toEqual({
      default: 'Northside Pharmacy',
      history: ['Northside Pharmacy', 'Dr. Chen Office', 'City Drug'],
    })
    expect(addresses.Home).toEqual({
      default: '200 Maple Blvd',
      history: ['200 Maple Blvd', '55 Oak Ave', '300 Cedar Rd', '100 Main St', '12 Park Lane'],
    })
    expect(addresses.MD).toEqual({
      default: 'Ann Lee, 1 Med Dr, Austin, TX',
      history: ['Ann Lee, 1 Med Dr, Austin, TX', 'Bob Zhu, 2 Care Ln, Dallas, TX', 'Cal Ngo, 3 Rd Ave, Houston, TX'],
    })
  })

  it('uses null default and empty history when a section has no value', () => {
    const { addresses } = buildProfileSections({
      key: 'nobody', patientName: 'Nobody', shipments: [{ id: 'n1', patientName: 'Nobody', patientNameLower: 'nobody', date: '2025-01-01', rxNumbers: [], address: '', facilityName: '', prescriberFirstName: '', prescriberLastName: '', prescriberAddress1: '', prescriberCity: '', prescriberState: '' }],
    })
    expect(addresses).toEqual({
      Facility: { default: null, history: [] },
      Home: { default: null, history: [] },
      MD: { default: null, history: [] },
    })
  })

  it('derives the insurance stub from the most recent shipment', () => {
    const { insurance } = buildProfileSections(janeGroup)
    expect(insurance).toEqual({
      awpCost: '300.00',
      copayAmount: '30.00',
      ndc: 'N3',
      quantityDispensed: '90',
      daysSupply: '30',
    })
  })

  it('collects unique non-blank facility names, newest-first', () => {
    const { facilityNames } = buildProfileSections(janeGroup)
    expect(facilityNames).toEqual(['Northside Pharmacy', 'Dr. Chen Office', 'City Drug'])
  })

  it('collects non-blank notes newest-first', () => {
    expect(buildProfileSections(janeGroup).notes).toEqual([
      'Call before delivery',
      'Leave at door',
      'Fragile',
      'Ring bell',
    ])
    expect(buildProfileSections(bobGroup).notes).toEqual(['Signature required'])
  })

  it('handles a group with no shipments', () => {
    expect(
      buildProfileSections({ key: 'nobody', patientName: 'Nobody', shipments: [] })
    ).toEqual({
      prescriptions: [],
      addresses: {
        Facility: { default: null, history: [] },
        Home: { default: null, history: [] },
        MD: { default: null, history: [] },
      },
      insurance: null,
      facilityNames: [],
      notes: [],
    })
  })
})
