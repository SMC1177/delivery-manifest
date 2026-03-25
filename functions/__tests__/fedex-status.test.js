import { describe, it, expect } from 'vitest'
import { mapFedExStatus } from '../fedex-status.js'

describe('mapFedExStatus', () => {
  describe('delivered statuses', () => {
    it('maps DL to delivered', () => {
      expect(mapFedExStatus('DL')).toBe('delivered')
    })
  })

  describe('in_transit statuses', () => {
    it.each([
      ['IT', 'In Transit'],
      ['IX', 'In Transit (international)'],
      ['OD', 'Out for Delivery'],
      ['AR', 'Arrived at facility'],
      ['DP', 'Departed facility'],
      ['PU', 'Picked Up'],
    ])('maps %s (%s) to in_transit', (code) => {
      expect(mapFedExStatus(code)).toBe('in_transit')
    })
  })

  describe('exception statuses', () => {
    it.each([
      ['DE', 'Delivery Exception'],
      ['CA', 'Cancelled'],
      ['SE', 'Shipment Exception'],
      ['HP', 'Hold at location'],
      ['RS', 'Return to Shipper'],
    ])('maps %s (%s) to exception', (code) => {
      expect(mapFedExStatus(code)).toBe('exception')
    })
  })

  describe('shipped statuses', () => {
    it.each([
      ['PX', 'Picked up (pre-shipment)'],
      ['OC', 'Order Created'],
      ['SH', 'Shipped'],
    ])('maps %s (%s) to shipped', (code) => {
      expect(mapFedExStatus(code)).toBe('shipped')
    })
  })

  describe('null/unknown handling', () => {
    it('returns null for null input', () => {
      expect(mapFedExStatus(null)).toBeNull()
    })

    it('returns null for undefined input', () => {
      expect(mapFedExStatus(undefined)).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(mapFedExStatus('')).toBeNull()
    })

    it('returns null for unknown code', () => {
      expect(mapFedExStatus('ZZ')).toBeNull()
    })
  })

  describe('case insensitivity', () => {
    it('handles lowercase dl', () => {
      expect(mapFedExStatus('dl')).toBe('delivered')
    })

    it('handles mixed case It', () => {
      expect(mapFedExStatus('It')).toBe('in_transit')
    })

    it('handles lowercase de', () => {
      expect(mapFedExStatus('de')).toBe('exception')
    })

    it('handles lowercase sh', () => {
      expect(mapFedExStatus('sh')).toBe('shipped')
    })
  })
})

describe('FedEx status mapping seam: mapFedExStatus → sync pipeline', () => {
  it('every mapped status is a valid app status', () => {
    const validAppStatuses = ['delivered', 'in_transit', 'exception', 'shipped']
    const allCodes = ['DL', 'IT', 'IX', 'OD', 'AR', 'DP', 'PU', 'DE', 'CA', 'SE', 'HP', 'RS', 'PX', 'OC', 'SH']

    for (const code of allCodes) {
      const result = mapFedExStatus(code)
      expect(validAppStatuses).toContain(result)
    }
  })

  it('unknown codes return null so sync pipeline skips them', () => {
    const unknownCodes = ['ZZ', 'INVALID', '123', 'XX']
    for (const code of unknownCodes) {
      expect(mapFedExStatus(code)).toBeNull()
    }
  })
})
