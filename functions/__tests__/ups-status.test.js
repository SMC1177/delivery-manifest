import { describe, it, expect } from 'vitest'
import { mapUpsStatus } from '../ups-status.js'

describe('mapUpsStatus', () => {
  describe('delivered statuses', () => {
    it('maps D to delivered', () => {
      expect(mapUpsStatus('D')).toBe('delivered')
    })
  })

  describe('in_transit statuses', () => {
    it.each([
      ['I', 'In Transit'],
      ['DO', 'Delivered Origin CFS'],
      ['DD', 'Delivered Destination CFS'],
    ])('maps %s (%s) to in_transit', (code) => {
      expect(mapUpsStatus(code)).toBe('in_transit')
    })
  })

  describe('exception statuses', () => {
    it.each([
      ['X', 'Exception'],
      ['RS', 'Returned to Shipper'],
      ['MV', 'Billing Information Voided'],
    ])('maps %s (%s) to exception', (code) => {
      expect(mapUpsStatus(code)).toBe('exception')
    })
  })

  describe('shipped statuses', () => {
    it.each([
      ['M', 'Manifest Pickup'],
      ['P', 'Pickup'],
    ])('maps %s (%s) to shipped', (code) => {
      expect(mapUpsStatus(code)).toBe('shipped')
    })
  })

  describe('null/unknown handling', () => {
    it('returns null for null input', () => {
      expect(mapUpsStatus(null)).toBeNull()
    })

    it('returns null for undefined input', () => {
      expect(mapUpsStatus(undefined)).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(mapUpsStatus('')).toBeNull()
    })

    it('returns null for unknown type', () => {
      expect(mapUpsStatus('ZZ')).toBeNull()
    })
  })

  describe('case insensitivity', () => {
    it('handles lowercase d', () => {
      expect(mapUpsStatus('d')).toBe('delivered')
    })

    it('handles lowercase i', () => {
      expect(mapUpsStatus('i')).toBe('in_transit')
    })

    it('handles lowercase x', () => {
      expect(mapUpsStatus('x')).toBe('exception')
    })

    it('handles lowercase m', () => {
      expect(mapUpsStatus('m')).toBe('shipped')
    })
  })

  describe('whitespace trimming', () => {
    it('trims leading/trailing whitespace', () => {
      expect(mapUpsStatus(' D ')).toBe('delivered')
      expect(mapUpsStatus('  I  ')).toBe('in_transit')
    })
  })
})

describe('UPS status mapping seam: mapUpsStatus → sync pipeline', () => {
  it('every mapped status is a valid app status', () => {
    const validAppStatuses = ['delivered', 'in_transit', 'exception', 'shipped']
    const allCodes = ['D', 'I', 'DO', 'DD', 'X', 'RS', 'MV', 'M', 'P']

    for (const code of allCodes) {
      const result = mapUpsStatus(code)
      expect(validAppStatuses).toContain(result)
    }
  })

  it('unknown codes return null so sync pipeline skips them', () => {
    const unknownCodes = ['ZZ', 'INVALID', '123', 'XX']
    for (const code of unknownCodes) {
      expect(mapUpsStatus(code)).toBeNull()
    }
  })
})
