import { describe, it, expect } from 'vitest'
import {
  normalizeDate,
  detectCarrierFromTracking,
  autoMapColumns,
  applyMapping,
  concatenateAddress,
  getUnmappedColumns,
} from '../utils/excelImport'

// --- 1-3: autoMapColumns ---

describe('autoMapColumns', () => {
  it('1. "Customer Name" auto-maps to patientName', () => {
    const result = autoMapColumns(['Customer Name', 'Some Other Col'])
    expect(result.patientName).toBe('Customer Name')
  })

  it('2. "Shipment Tracking Number" auto-maps to trackingNumber', () => {
    const result = autoMapColumns(['Shipment Tracking Number'])
    expect(result.trackingNumber).toBe('Shipment Tracking Number')
  })

  it('3. "Customer Primary Phone Number" auto-maps to phone', () => {
    const result = autoMapColumns(['Customer Primary Phone Number'])
    expect(result.phone).toBe('Customer Primary Phone Number')
  })

  it('4. unknown column like "Drug GPI" returns no mapping', () => {
    const result = autoMapColumns(['Drug GPI', 'NDC', 'AWP Cost'])
    expect(result.patientName).toBeUndefined()
    expect(result.trackingNumber).toBeUndefined()
    expect(Object.keys(result)).toHaveLength(0)
  })

  it('does not match "Prescriber State" to address state field', () => {
    const result = autoMapColumns([
      'Ship To Address1', 'Ship To City', 'Ship To State', 'Ship To Zip Code',
      'Prescriber State', 'Prescriber Name'
    ])
    expect(result.address).toContain('Ship To City')
    expect(result.address).toContain('Ship To State')
    expect(result.address).toContain('Ship To Zip Code')
    expect(result.address).not.toContain('Prescriber State')
  })
})

// --- 5: applyMapping ---

describe('applyMapping', () => {
  it('5. maps row using saved config correctly', () => {
    const mapping = {
      patientName: 'Customer Name',
      trackingNumber: 'Tracking #',
      phone: 'Phone',
      date: 'Date Filled',
      rxNumbers: 'Rx Number',
    }
    const rows = [{
      'Customer Name': 'Alice Smith',
      'Tracking #': '1Z12345E1512345676',
      'Phone': '555-1234',
      'Date Filled': '03/27/2026',
      'Rx Number': 'RX100, RX200',
      'Drug GPI': '12345678',
      'NDC': '99999-9999-99',
    }]
    const result = applyMapping(rows, mapping)
    expect(result[0].patientName).toBe('Alice Smith')
    expect(result[0].trackingNumber).toBe('1Z12345E1512345676')
    expect(result[0].phone).toBe('555-1234')
    expect(result[0].date).toBe('2026-03-27')
    expect(result[0].rxNumbers).toEqual(['RX100', 'RX200'])
    expect(result[0].carrier).toBe('ups')
    // Drug GPI and NDC should NOT appear on the result
    expect(result[0]).not.toHaveProperty('Drug GPI')
    expect(result[0]).not.toHaveProperty('NDC')
  })
})

// --- 6: concatenateAddress ---

describe('concatenateAddress', () => {
  it('6. combines Address1 + City + State + Zip, skips empty parts', () => {
    const row = {
      'Ship To Address1': '123 Main St',
      'Ship To Address2': '',
      'Ship To City': 'Houston',
      'Ship To State': 'TX',
      'Ship To Zip Code': '77001',
    }
    const result = concatenateAddress(row, [
      'Ship To Address1',
      'Ship To Address2',
      'Ship To City',
      'Ship To State',
      'Ship To Zip Code',
    ])
    expect(result).toBe('123 Main St, Houston, TX, 77001')
  })
})

// --- 7-9: normalizeDate ---

describe('normalizeDate', () => {
  it('7. converts Excel serial (45678) to correct YYYY-MM-DD', () => {
    expect(normalizeDate(45678)).toBe('2025-01-21')
  })

  it('8. converts MM/DD/YYYY string', () => {
    expect(normalizeDate('03/15/2026')).toBe('2026-03-15')
  })

  it('9. passes through YYYY-MM-DD unchanged', () => {
    expect(normalizeDate('2026-03-27')).toBe('2026-03-27')
  })
})

// --- 10-11: skip and dedup ---

describe('skip and dedup logic', () => {
  it('10. row with no tracking number skipped', () => {
    const mapping = { patientName: 'Name', trackingNumber: 'TN' }
    const rows = [
      { Name: 'Has TN', TN: '1ZABC' },
      { Name: 'No TN', TN: '' },
    ]
    const result = applyMapping(rows, mapping)
    const withTN = result.filter((s) => s.trackingNumber)
    const withoutTN = result.filter((s) => !s.trackingNumber)
    expect(withTN).toHaveLength(1)
    expect(withoutTN).toHaveLength(1)
  })

  it('11. existing tracking number detected as duplicate', () => {
    const mapping = { patientName: 'Name', trackingNumber: 'TN' }
    const rows = [
      { Name: 'New', TN: '1ZNEW' },
      { Name: 'Existing', TN: '1ZEXISTING' },
    ]
    const result = applyMapping(rows, mapping)
    const existingSet = new Set(['1zexisting'])
    const fresh = result.filter((s) => s.trackingNumber && !existingSet.has(s.trackingNumber.toLowerCase()))
    const dupes = result.filter((s) => s.trackingNumber && existingSet.has(s.trackingNumber.toLowerCase()))
    expect(fresh).toHaveLength(1)
    expect(dupes).toHaveLength(1)
  })
})

// --- 12: Rx splitting ---

describe('Rx number parsing', () => {
  it('12. "RX1, RX2, RX3" splits into array of 3', () => {
    const mapping = { patientName: 'Name', rxNumbers: 'RX' }
    const rows = [{ Name: 'Test', RX: 'RX001, RX002, RX003' }]
    const result = applyMapping(rows, mapping)
    expect(result[0].rxNumbers).toEqual(['RX001', 'RX002', 'RX003'])
  })
})

// --- 13: case-insensitive ---

describe('case sensitivity', () => {
  it('13. column header matching is case-insensitive', () => {
    const result = autoMapColumns(['CUSTOMER NAME', 'SHIPMENT TRACKING NUMBER'])
    expect(result.patientName).toBe('CUSTOMER NAME')
    expect(result.trackingNumber).toBe('SHIPMENT TRACKING NUMBER')
  })
})

// --- 14: detectCarrier ---

describe('detectCarrierFromTracking', () => {
  it('14. "1Z..." → ups, 12-digit → fedex, unknown → other', () => {
    expect(detectCarrierFromTracking('1Z12345E1512345676')).toBe('ups')
    expect(detectCarrierFromTracking('123456789012')).toBe('fedex')
    expect(detectCarrierFromTracking('ABCXYZ')).toBe('other')
  })
})

// --- 15-16: SCRUB TESTS ---

describe('scrub behavior', () => {
  it('15. imported shipment contains ONLY mapped fields — no Drug GPI, NDC, etc.', () => {
    const mapping = {
      patientName: 'Customer Name',
      trackingNumber: 'Tracking #',
    }
    const rows = [{
      'Customer Name': 'John Doe',
      'Tracking #': '1ZABC',
      'Drug GPI': '12345',
      'NDC': '99999',
      'AWP Cost': '$50.00',
      'Copay': '$10.00',
      'Prescriber': 'Dr. Smith',
    }]
    const result = applyMapping(rows, mapping)
    const keys = Object.keys(result[0])
    // Should only have universal shipment fields
    expect(keys).toContain('patientName')
    expect(keys).toContain('trackingNumber')
    expect(keys).not.toContain('Drug GPI')
    expect(keys).not.toContain('NDC')
    expect(keys).not.toContain('AWP Cost')
    expect(keys).not.toContain('Copay')
    expect(keys).not.toContain('Prescriber')
  })

  it('16. unmappedColumns list contains all columns not in the mapping', () => {
    const allHeaders = ['Customer Name', 'Tracking #', 'Drug GPI', 'NDC', 'AWP Cost']
    const mapping = {
      patientName: 'Customer Name',
      trackingNumber: 'Tracking #',
    }
    const unmapped = getUnmappedColumns(allHeaders, mapping)
    expect(unmapped).toEqual(['Drug GPI', 'NDC', 'AWP Cost'])
  })
})
