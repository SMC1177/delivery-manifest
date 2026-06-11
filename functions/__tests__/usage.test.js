// functions/__tests__/usage.test.js
import { describe, it, expect } from 'vitest'
import { monthKeyCentral, carrierBucket, shipmentMonthKey, buildUsageDeltas } from '../lib/usage.js'

describe('monthKeyCentral', () => {
  it('returns null for null/undefined', () => {
    expect(monthKeyCentral(null)).toBeNull()
    expect(monthKeyCentral(undefined)).toBeNull()
  })

  it('returns null for garbage input', () => {
    expect(monthKeyCentral('garbage')).toBeNull()
    expect(monthKeyCentral({})).toBeNull()
  })

  it('handles CT boundary: 2026-06-01T03:30:00Z is still May in CT', () => {
    const d = new Date('2026-06-01T03:30:00Z')
    expect(monthKeyCentral(d)).toBe('2026-05')
  })

  it('handles CT boundary: 2026-06-01T06:00:00Z is June in CT', () => {
    const d = new Date('2026-06-01T06:00:00Z')
    expect(monthKeyCentral(d)).toBe('2026-06')
  })

  it('handles Firestore Timestamp-like object with toDate', () => {
    const ts = { toDate: () => new Date('2026-06-15T12:00:00Z') }
    expect(monthKeyCentral(ts)).toBe('2026-06')
  })

  it('handles object with seconds property (epoch seconds)', () => {
    const epoch = Date.parse('2026-06-15T12:00:00Z') / 1000
    expect(monthKeyCentral({ seconds: epoch })).toBe('2026-06')
  })

  it('handles epoch milliseconds number', () => {
    const ms = Date.parse('2026-06-15T12:00:00Z')
    expect(monthKeyCentral(ms)).toBe('2026-06')
  })

  it('handles ISO string', () => {
    expect(monthKeyCentral('2026-06-15T12:00:00Z')).toBe('2026-06')
  })
})

describe('carrierBucket', () => {
  it('normalizes ups', () => {
    expect(carrierBucket('ups')).toBe('ups')
    expect(carrierBucket('UPS')).toBe('ups')
  })

  it('normalizes fedex with whitespace', () => {
    expect(carrierBucket(' FedEx ')).toBe('fedex')
  })

  it('normalizes usps', () => {
    expect(carrierBucket('USPS')).toBe('usps')
  })

  it('returns other for dhl', () => {
    expect(carrierBucket('dhl')).toBe('other')
  })

  it('returns other for empty string', () => {
    expect(carrierBucket('')).toBe('other')
  })

  it('returns other for non-string inputs', () => {
    expect(carrierBucket(null)).toBe('other')
    expect(carrierBucket(undefined)).toBe('other')
    expect(carrierBucket(42)).toBe('other')
  })
})

describe('shipmentMonthKey', () => {
  it('uses createdAt Timestamp-like over date string', () => {
    const shipment = {
      createdAt: { toDate: () => new Date('2026-04-15T12:00:00Z') },
      date: '2026-05-01'
    }
    expect(shipmentMonthKey(shipment)).toBe('2026-04')
  })

  it('falls back to date string when createdAt missing', () => {
    const shipment = { date: '2026-04-09' }
    expect(shipmentMonthKey(shipment)).toBe('2026-04')
  })

  it('uses fallback Date when both createdAt and date missing', () => {
    const shipment = {}
    const fallback = new Date('2026-07-15T12:00:00Z')
    expect(shipmentMonthKey(shipment, fallback)).toBe('2026-07')
  })

  it('returns null for null shipment without fallback', () => {
    expect(shipmentMonthKey(null)).toBeNull()
  })

  it('returns fallback month for null shipment with fallback', () => {
    const fallback = new Date('2026-08-01T06:00:00Z')
    expect(shipmentMonthKey(null, fallback)).toBe('2026-08')
  })
})

describe('buildUsageDeltas', () => {
  it('returns correct nested structure with positive delta', () => {
    const result = buildUsageDeltas('2026-06', 'ups', 1)
    expect(result).toEqual({
      shipmentCount: 1,
      monthlyUsage: {
        '2026-06': {
          ups: 1,
          total: 1
        }
      }
    })
  })

  it('propagates negative delta to all leaves', () => {
    const result = buildUsageDeltas('2026-06', 'fedex', -1)
    expect(result).toEqual({
      shipmentCount: -1,
      monthlyUsage: {
        '2026-06': {
          fedex: -1,
          total: -1
        }
      }
    })
  })

  it('applies wrap function to every numeric leaf', () => {
    const wrap = (n) => ({ inc: n })
    const result = buildUsageDeltas('2026-06', 'usps', 1, wrap)
    expect(result).toEqual({
      shipmentCount: { inc: 1 },
      monthlyUsage: {
        '2026-06': {
          usps: { inc: 1 },
          total: { inc: 1 }
        }
      }
    })
  })
})
