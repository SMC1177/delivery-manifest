import { describe, it, expect } from 'vitest'
import { getTrackingUrl, getCarrierName, CARRIER_OPTIONS } from '../lib/carriers'

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

  it('returns raw value for unknown carrier', () => {
    expect(getCarrierName('dhl')).toBe('dhl')
  })

  it('handles uppercase carrier names', () => {
    expect(getCarrierName('UPS')).toBe('UPS')
    expect(getCarrierName('FEDEX')).toBe('FedEx')
  })
})

describe('CARRIER_OPTIONS', () => {
  it('includes UPS and FedEx', () => {
    expect(CARRIER_OPTIONS).toEqual(
      expect.arrayContaining([
        { value: 'ups', label: 'UPS' },
        { value: 'fedex', label: 'FedEx' },
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
