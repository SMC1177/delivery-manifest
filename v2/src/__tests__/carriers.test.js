import { describe, it, expect } from 'vitest'
import { getTrackingUrl, getCarrierName, CARRIER_OPTIONS, detectCarrier } from '../lib/carriers'

describe('getTrackingUrl', () => {
  it('returns UPS tracking URL', () => {
    const url = getTrackingUrl('ups', '1Z999AA10123456784')
    expect(url).toContain('ups.com/track')
    expect(url).toContain('1Z999AA10123456784')
  })

  it('returns FedEx tracking URL', () => {
    const url = getTrackingUrl('fedex', '789456123012')
    expect(url).toContain('fedex.com/fedextrack')
    expect(url).toContain('789456123012')
  })

  it('encodes special characters in tracking number', () => {
    const url = getTrackingUrl('ups', '1Z 999&AA')
    expect(url).not.toContain(' ')
    expect(url).toContain('1Z%20999%26AA')
  })

  it('returns USPS tracking URL', () => {
    const url = getTrackingUrl('usps', '94001234567890123456')
    expect(url).toContain('tools.usps.com/go/TrackConfirmAction')
    expect(url).toContain('94001234567890123456')
  })

  it('handles uppercase USPS carrier', () => {
    const url = getTrackingUrl('USPS', '94001234567890123456')
    expect(url).toContain('tools.usps.com/go/TrackConfirmAction')
  })

  it('handles mixed case Usps carrier', () => {
    const url = getTrackingUrl('Usps', '94001234567890123456')
    expect(url).toContain('tools.usps.com/go/TrackConfirmAction')
  })

  it('returns null for unknown carrier', () => {
    expect(getTrackingUrl('dhl', '123')).toBeNull()
  })

  it('returns null for missing tracking number', () => {
    expect(getTrackingUrl('ups', '')).toBeNull()
    expect(getTrackingUrl('ups', null)).toBeNull()
    expect(getTrackingUrl('ups', undefined)).toBeNull()
  })

  it('returns null for missing carrier', () => {
    expect(getTrackingUrl(null, '123')).toBeNull()
    expect(getTrackingUrl(undefined, '123')).toBeNull()
  })

  it('handles uppercase UPS carrier', () => {
    const url = getTrackingUrl('UPS', '1Z999AA10123456784')
    expect(url).toContain('ups.com/track')
    expect(url).toContain('1Z999AA10123456784')
  })

  it('handles uppercase FEDEX carrier', () => {
    const url = getTrackingUrl('FEDEX', '789456123012')
    expect(url).toContain('fedex.com/fedextrack')
  })

  it('handles mixed case carrier', () => {
    const url = getTrackingUrl('Ups', '1Z999AA10123456784')
    expect(url).toContain('ups.com/track')
  })

  it('returns null for empty string carrier', () => {
    expect(getTrackingUrl('', '123')).toBeNull()
  })
})

describe('getCarrierName', () => {
  it('returns UPS for ups', () => {
    expect(getCarrierName('ups')).toBe('UPS')
  })

  it('returns FedEx for fedex', () => {
    expect(getCarrierName('fedex')).toBe('FedEx')
  })

  it('returns USPS for usps', () => {
    expect(getCarrierName('usps')).toBe('USPS')
  })

  it('returns raw value for unknown carrier', () => {
    expect(getCarrierName('dhl')).toBe('dhl')
  })

  it('handles uppercase carrier names', () => {
    expect(getCarrierName('UPS')).toBe('UPS')
    expect(getCarrierName('FEDEX')).toBe('FedEx')
    expect(getCarrierName('USPS')).toBe('USPS')
  })
})

describe('CARRIER_OPTIONS', () => {
  it('includes UPS, FedEx, and USPS', () => {
    expect(CARRIER_OPTIONS).toEqual(
      expect.arrayContaining([
        { value: 'ups', label: 'UPS' },
        { value: 'fedex', label: 'FedEx' },
        { value: 'usps', label: 'USPS' },
      ])
    )
  })

  it('each option has value and label', () => {
    for (const opt of CARRIER_OPTIONS) {
      expect(opt).toHaveProperty('value')
      expect(opt).toHaveProperty('label')
      expect(typeof opt.value).toBe('string')
      expect(typeof opt.label).toBe('string')
    }
  })
})

describe('detectCarrier', () => {
  it('detects UPS tracking numbers (starts with 1Z)', () => {
    expect(detectCarrier('1Z999AA10123456784')).toBe('ups')
  })

  it('detects UPS case-insensitively', () => {
    expect(detectCarrier('1z999AA10123456784')).toBe('ups')
  })

  it('detects USPS tracking numbers (starts with 9, 20 digits)', () => {
    expect(detectCarrier('94001234567890123456')).toBe('usps')
  })

  it('detects USPS tracking numbers (21 digits)', () => {
    expect(detectCarrier('940012345678901234567')).toBe('usps')
  })

  it('detects USPS tracking numbers (22 digits)', () => {
    expect(detectCarrier('9400123456789012345678')).toBe('usps')
  })

  it('does not detect USPS for 19 digit number starting with 9', () => {
    expect(detectCarrier('9400123456789012345')).toBeNull()
  })

  it('does not detect USPS for 23 digit number starting with 9', () => {
    expect(detectCarrier('94001234567890123456789')).toBeNull()
  })

  it('detects FedEx tracking numbers (12 digits)', () => {
    expect(detectCarrier('789456123012')).toBe('fedex')
  })

  it('detects FedEx tracking numbers (15 digits)', () => {
    expect(detectCarrier('123456789012345')).toBe('fedex')
  })

  it('returns null for unknown format', () => {
    expect(detectCarrier('ABC123')).toBeNull()
  })

  it('returns null for null/undefined/empty', () => {
    expect(detectCarrier(null)).toBeNull()
    expect(detectCarrier(undefined)).toBeNull()
    expect(detectCarrier('')).toBeNull()
  })

  it('trims whitespace before detection', () => {
    expect(detectCarrier('  1Z999AA10123456784  ')).toBe('ups')
  })
})
