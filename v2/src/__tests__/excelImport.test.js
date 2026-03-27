import { describe, it, expect } from 'vitest'
import {
  normalizeDate,
  detectCarrierFromTracking,
  mapRowsToShipments,
} from '../utils/excelImport'

describe('normalizeDate', () => {
  it('converts Excel serial number to YYYY-MM-DD', () => {
    // 45678 = 2025-01-21
    const result = normalizeDate(45678)
    expect(result).toBe('2025-01-21')
  })

  it('converts MM/DD/YYYY string', () => {
    expect(normalizeDate('03/15/2026')).toBe('2026-03-15')
  })

  it('passes through YYYY-MM-DD unchanged', () => {
    expect(normalizeDate('2026-03-27')).toBe('2026-03-27')
  })

  it('handles Date objects', () => {
    const d = new Date('2026-06-15T00:00:00Z')
    expect(normalizeDate(d)).toBe('2026-06-15')
  })

  it('returns empty string for null/undefined/empty', () => {
    expect(normalizeDate(null)).toBe('')
    expect(normalizeDate(undefined)).toBe('')
    expect(normalizeDate('')).toBe('')
  })

  it('handles numeric string (serial as string)', () => {
    const result = normalizeDate('45678')
    expect(result).toBe('2025-01-21')
  })

  it('handles single-digit month/day MM/DD/YYYY', () => {
    expect(normalizeDate('1/5/2026')).toBe('2026-01-05')
  })
})

describe('detectCarrierFromTracking', () => {
  it('"1Z..." returns "ups"', () => {
    expect(detectCarrierFromTracking('1Z12345E1512345676')).toBe('ups')
  })

  it('12-digit number returns "fedex"', () => {
    expect(detectCarrierFromTracking('123456789012')).toBe('fedex')
  })

  it('15-digit number returns "fedex"', () => {
    expect(detectCarrierFromTracking('123456789012345')).toBe('fedex')
  })

  it('"9" followed by 20+ digits returns "usps"', () => {
    expect(detectCarrierFromTracking('92748999999999999999')).toBe('usps')
  })

  it('unknown format returns "other"', () => {
    expect(detectCarrierFromTracking('ABCXYZ')).toBe('other')
  })

  it('empty/null returns "other"', () => {
    expect(detectCarrierFromTracking('')).toBe('other')
    expect(detectCarrierFromTracking(null)).toBe('other')
  })
})

describe('mapRowsToShipments', () => {
  it('"Customer Name" maps to patientName', () => {
    const headers = ['Customer Name', 'Tracking Number']
    const rows = [['John Doe', '1Z12345E1512345676']]
    const result = mapRowsToShipments(rows, headers)
    expect(result[0].patientName).toBe('John Doe')
  })

  it('"Shipment Tracking Number" maps to trackingNumber', () => {
    const headers = ['Patient Name', 'Shipment Tracking Number']
    const rows = [['Jane Doe', '1Z99999']]
    const result = mapRowsToShipments(rows, headers)
    expect(result[0].trackingNumber).toBe('1Z99999')
  })

  it('column header matching is case-insensitive', () => {
    const headers = ['CUSTOMER NAME', 'TRACKING NUMBER']
    const rows = [['Case Test', '1ZABC']]
    const result = mapRowsToShipments(rows, headers)
    expect(result[0].patientName).toBe('Case Test')
    expect(result[0].trackingNumber).toBe('1ZABC')
  })

  it('"RX1, RX2, RX3" splits into array of 3', () => {
    const headers = ['Patient Name', 'Rx Number']
    const rows = [['Test', 'RX001, RX002, RX003']]
    const result = mapRowsToShipments(rows, headers)
    expect(result[0].rxNumbers).toEqual(['RX001', 'RX002', 'RX003'])
  })

  it('splits Rx on semicolons', () => {
    const headers = ['Patient Name', 'Rx Number']
    const rows = [['Test', 'RX001;RX002']]
    const result = mapRowsToShipments(rows, headers)
    expect(result[0].rxNumbers).toEqual(['RX001', 'RX002'])
  })

  it('maps all pharmacy export columns', () => {
    const headers = [
      'Customer Name',
      'Customer Phone',
      'Customer Birthday',
      'Ship To Address',
      'Rx Number',
      'Shipment Tracking Number',
      'Date Filled',
      'Dispensed Drug Name',
    ]
    const rows = [[
      'Alice Smith',
      '555-1234',
      '01/15/1980',
      '123 Main St',
      'RX100',
      '1Z12345E1512345676',
      '03/27/2026',
      'Amoxicillin 500mg',
    ]]
    const result = mapRowsToShipments(rows, headers)
    expect(result[0]).toEqual({
      patientName: 'Alice Smith',
      phone: '555-1234',
      dateOfBirth: '1980-01-15',
      address: '123 Main St',
      rxNumbers: ['RX100'],
      trackingNumber: '1Z12345E1512345676',
      carrier: 'ups',
      date: '2026-03-27',
      notes: 'Amoxicillin 500mg',
    })
  })

  it('handles rows with missing columns gracefully', () => {
    const headers = ['Patient Name']
    const rows = [['Only Name']]
    const result = mapRowsToShipments(rows, headers)
    expect(result[0].patientName).toBe('Only Name')
    expect(result[0].trackingNumber).toBe('')
    expect(result[0].rxNumbers).toEqual([])
  })
})

describe('parseExcelFile — dedup and skip logic', () => {
  // We can't easily test the full parseExcelFile without a real XLSX buffer,
  // but we test the skip/dedup logic via mapRowsToShipments + manual filtering

  it('row with no tracking number is skipped', () => {
    const headers = ['Patient Name', 'Tracking Number']
    const rows = [
      ['Has Tracking', '1ZABC123'],
      ['No Tracking', ''],
      ['Also No Tracking', '   '],
    ]
    const mapped = mapRowsToShipments(rows, headers)
    const withTracking = mapped.filter((s) => s.trackingNumber)
    const withoutTracking = mapped.filter((s) => !s.trackingNumber)
    expect(withTracking).toHaveLength(1)
    expect(withoutTracking).toHaveLength(2)
  })

  it('row with existing tracking number is counted as duplicate', () => {
    const headers = ['Patient Name', 'Tracking Number']
    const rows = [
      ['New', '1ZNEW'],
      ['Existing', '1ZEXISTING'],
    ]
    const mapped = mapRowsToShipments(rows, headers)
    const existingSet = new Set(['1zexisting'])
    const fresh = mapped.filter(
      (s) => s.trackingNumber && !existingSet.has(s.trackingNumber.toLowerCase())
    )
    const dupes = mapped.filter(
      (s) => s.trackingNumber && existingSet.has(s.trackingNumber.toLowerCase())
    )
    expect(fresh).toHaveLength(1)
    expect(fresh[0].patientName).toBe('New')
    expect(dupes).toHaveLength(1)
    expect(dupes[0].patientName).toBe('Existing')
  })
})
