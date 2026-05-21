import { describe, it, expect } from 'vitest'
import { mapUpsStatus } from '../ups-status.js'

describe('mapUpsStatus', () => {
  describe('description-first: delivered', () => {
    it('maps "Delivered" description to delivered', () => {
      expect(mapUpsStatus({ description: 'Delivered' })).toBe('delivered')
    })

    it('maps "Package was delivered" to delivered', () => {
      expect(mapUpsStatus({ description: 'Package was delivered' })).toBe('delivered')
    })

    it('maps "Left at door" to delivered', () => {
      expect(mapUpsStatus({ description: 'Left at door' })).toBe('delivered')
    })

    it('maps "left at front door" (case-insensitive) to delivered', () => {
      expect(mapUpsStatus({ description: 'Left at Front Door' })).toBe('delivered')
    })
  })

  describe('description-first: return to sender beats delivered keyword', () => {
    it('maps "Return to Sender" to exception', () => {
      expect(mapUpsStatus({ description: 'Return to Sender' })).toBe('exception')
    })

    it('maps "Returned to Sender" to exception', () => {
      expect(mapUpsStatus({ description: 'Returned to Sender' })).toBe('exception')
    })

    it('maps "Returning to Sender" to exception', () => {
      expect(mapUpsStatus({ description: 'Returning to Sender' })).toBe('exception')
    })

    it('maps "RTS" to exception', () => {
      expect(mapUpsStatus({ description: 'RTS' })).toBe('exception')
    })
  })

  describe('description-first: in_transit', () => {
    it('maps "On the Way" to in_transit', () => {
      expect(mapUpsStatus({ code: '005', description: 'On the Way' })).toBe('in_transit')
    })

    it('maps "Out for Delivery" to in_transit', () => {
      expect(mapUpsStatus({ description: 'Out for Delivery' })).toBe('in_transit')
    })

    it('maps "Loaded on delivery vehicle" to in_transit', () => {
      expect(mapUpsStatus({ description: 'Loaded on delivery vehicle' })).toBe('in_transit')
    })

    it('maps "Arrived at Facility" to in_transit', () => {
      expect(mapUpsStatus({ description: 'Arrived at Facility' })).toBe('in_transit')
    })

    it('maps "Departed facility" to in_transit', () => {
      expect(mapUpsStatus({ description: 'Departed from facility' })).toBe('in_transit')
    })

    it('maps "In Transit" description to in_transit', () => {
      expect(mapUpsStatus({ description: 'In Transit' })).toBe('in_transit')
    })
  })

  describe('description-first: exception', () => {
    it('maps "Exception" description to exception', () => {
      expect(mapUpsStatus({ description: 'Exception' })).toBe('exception')
    })

    it('maps "Delivery Attempted" to exception', () => {
      expect(mapUpsStatus({ description: 'Delivery Attempted' })).toBe('exception')
    })

    it('maps "Receiver was not available" to exception', () => {
      expect(mapUpsStatus({ description: 'Receiver was not available' })).toBe('exception')
    })

    it('maps "Weather delay" to exception', () => {
      expect(mapUpsStatus({ description: 'Weather delay' })).toBe('exception')
    })
  })

  describe('description-first: shipped/label', () => {
    it('maps "Label Created" description to shipped', () => {
      expect(mapUpsStatus({ description: 'Label Created' })).toBe('shipped')
    })

    it('maps "Shipment Ready for UPS" to shipped', () => {
      expect(mapUpsStatus({ description: 'Shipment Ready for UPS' })).toBe('shipped')
    })
  })

  describe('letter type code fallback (no description)', () => {
    it('maps type D to delivered', () => {
      expect(mapUpsStatus({ type: 'D' })).toBe('delivered')
    })

    it('maps type I to in_transit', () => {
      expect(mapUpsStatus({ type: 'I' })).toBe('in_transit')
    })

    it('maps type O to in_transit', () => {
      expect(mapUpsStatus({ type: 'O' })).toBe('in_transit')
    })

    it('maps type DO to in_transit', () => {
      expect(mapUpsStatus({ type: 'DO' })).toBe('in_transit')
    })

    it('maps type DD to in_transit', () => {
      expect(mapUpsStatus({ type: 'DD' })).toBe('in_transit')
    })

    it('maps type X to exception', () => {
      expect(mapUpsStatus({ type: 'X' })).toBe('exception')
    })

    it('maps type RS to exception', () => {
      expect(mapUpsStatus({ type: 'RS' })).toBe('exception')
    })

    it('maps type MV to exception', () => {
      expect(mapUpsStatus({ type: 'MV' })).toBe('exception')
    })

    it('maps type M to shipped', () => {
      expect(mapUpsStatus({ type: 'M' })).toBe('shipped')
    })

    it('maps type P to shipped', () => {
      expect(mapUpsStatus({ type: 'P' })).toBe('shipped')
    })

    it('handles lowercase type (case-insensitive)', () => {
      expect(mapUpsStatus({ type: 'd' })).toBe('delivered')
      expect(mapUpsStatus({ type: 'i' })).toBe('in_transit')
      expect(mapUpsStatus({ type: 'x' })).toBe('exception')
      expect(mapUpsStatus({ type: 'm' })).toBe('shipped')
    })

    it('trims whitespace from type', () => {
      expect(mapUpsStatus({ type: ' D ' })).toBe('delivered')
      expect(mapUpsStatus({ type: '  I  ' })).toBe('in_transit')
    })
  })

  describe('numeric code fallback (no description, no type)', () => {
    it('maps code 002 to in_transit', () => {
      expect(mapUpsStatus({ code: '002' })).toBe('in_transit')
    })

    it('maps code 003 to delivered', () => {
      expect(mapUpsStatus({ code: '003' })).toBe('delivered')
    })

    it('maps code 004 to in_transit', () => {
      expect(mapUpsStatus({ code: '004' })).toBe('in_transit')
    })

    it('maps code 006 to shipped', () => {
      expect(mapUpsStatus({ code: '006' })).toBe('shipped')
    })

    it('maps code 007 to shipped', () => {
      expect(mapUpsStatus({ code: '007' })).toBe('shipped')
    })

    it('code 005 alone returns null — description required to discriminate', () => {
      expect(mapUpsStatus({ code: '005' })).toBeNull()
    })

    it('returns null for unknown numeric code 099 with no description', () => {
      expect(mapUpsStatus({ code: '099' })).toBeNull()
    })
  })

  describe('null/unknown/empty handling', () => {
    it('returns null for null input', () => {
      expect(mapUpsStatus(null)).toBeNull()
    })

    it('returns null for undefined input', () => {
      expect(mapUpsStatus(undefined)).toBeNull()
    })

    it('returns null for empty object', () => {
      expect(mapUpsStatus({})).toBeNull()
    })

    it('returns null for unknown type with no description', () => {
      expect(mapUpsStatus({ type: 'ZZ' })).toBeNull()
    })

    it('returns null for unknown type even when description is present but unrecognized', () => {
      expect(mapUpsStatus({ type: 'ZZ', description: 'Some unknown scan' })).toBeNull()
    })
  })
})

describe('UPS status mapping seam: mapUpsStatus → sync pipeline', () => {
  it.each(['D', 'I', 'O', 'DO', 'DD', 'X', 'RS', 'MV', 'M', 'P'])(
    'letter code %s produces a valid app status',
    (type) => {
      const validAppStatuses = ['delivered', 'in_transit', 'exception', 'shipped']
      expect(validAppStatuses).toContain(mapUpsStatus({ type }))
    }
  )

  it.each(['ZZ', 'INVALID', 'XX'])(
    'unknown type %s with no description returns null so sync pipeline skips it',
    (type) => {
      expect(mapUpsStatus({ type })).toBeNull()
    }
  )

  it('description "On the Way" + code 005 maps to in_transit (not exception)', () => {
    expect(mapUpsStatus({ code: '005', description: 'On the Way' })).toBe('in_transit')
  })

  it('description "Return to Sender" + code 005 maps to exception (not in_transit)', () => {
    expect(mapUpsStatus({ code: '005', description: 'Return to Sender' })).toBe('exception')
  })
})
