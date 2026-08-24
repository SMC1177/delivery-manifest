import { describe, it, expect } from 'vitest'
import { detectCarrier, trackingUrlFor, carrierLabel } from '../carrier-detection.js'

describe('detectCarrier', () => {
  describe('UPS detection', () => {
    it('detects 1Z prefix as UPS', () => {
      expect(detectCarrier('1Z999AA10123456784')).toBe('ups')
    })

    it('detects lowercase 1z as UPS', () => {
      expect(detectCarrier('1z999AA10123456784')).toBe('ups')
    })
  })

  describe('USPS detection', () => {
    it('detects 20-digit number starting with 9 as USPS', () => {
      expect(detectCarrier('94001234567890123456')).toBe('usps')
    })

    it('detects 21-digit number starting with 9 as USPS', () => {
      expect(detectCarrier('940012345678901234567')).toBe('usps')
    })

    it('detects 22-digit number starting with 9 as USPS', () => {
      expect(detectCarrier('9400123456789012345678')).toBe('usps')
    })

    it('rejects 19-digit number starting with 9', () => {
      expect(detectCarrier('9400123456789012345')).toBeNull()
    })

    it('rejects 23-digit number starting with 9', () => {
      expect(detectCarrier('94001234567890123456789')).toBeNull()
    })
  })

  describe('FedEx detection', () => {
    it('detects 12-digit number as FedEx', () => {
      expect(detectCarrier('789456123012')).toBe('fedex')
    })

    it('detects 15-digit number as FedEx', () => {
      expect(detectCarrier('123456789012345')).toBe('fedex')
    })
  })

  describe('edge cases', () => {
    it('returns null for null', () => {
      expect(detectCarrier(null)).toBeNull()
    })

    it('returns null for undefined', () => {
      expect(detectCarrier(undefined)).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(detectCarrier('')).toBeNull()
    })

    it('returns null for non-string', () => {
      expect(detectCarrier(12345)).toBeNull()
    })

    it('returns null for unrecognized format', () => {
      expect(detectCarrier('ABC123')).toBeNull()
    })

    it('trims whitespace before detection', () => {
      expect(detectCarrier('  1Z999AA10123456784  ')).toBe('ups')
    })
  })
})

describe('trackingUrlFor', () => {
  it('builds the UPS tracking URL embedding the number', () => {
    expect(trackingUrlFor('1Z999AA10123456784')).toBe('https://www.ups.com/track?tracknum=1Z999AA10123456784')
  })

  it('builds the USPS tracking URL embedding the number', () => {
    expect(trackingUrlFor('94001234567890123456')).toBe('https://tools.usps.com/go/TrackConfirmAction?tLabels=94001234567890123456')
  })

  it('builds the FedEx tracking URL embedding the number', () => {
    expect(trackingUrlFor('539404639669')).toBe('https://www.fedex.com/fedextrack/?trknbr=539404639669')
  })

  it('falls back to the bare trimmed number when no carrier pattern matches', () => {
    expect(trackingUrlFor('  ABC123  ')).toBe('ABC123')
  })

  it('returns an empty string for blank input', () => {
    expect(trackingUrlFor('')).toBe('')
    expect(trackingUrlFor(null)).toBe('')
  })
})

describe('carrierLabel', () => {
  it('labels the three carriers', () => {
    expect(carrierLabel('1Z999AA10123456784')).toBe('UPS')
    expect(carrierLabel('94001234567890123456')).toBe('USPS')
    expect(carrierLabel('539404639669')).toBe('FedEx')
  })

  it('returns an empty string when unrecognized or blank', () => {
    expect(carrierLabel('ABC123')).toBe('')
    expect(carrierLabel('')).toBe('')
  })
})
