import { describe, it, expect } from 'vitest'
import { mapUpsStatus, deriveUpsStatusContext, isStaleDelivery } from '../ups-status.js'

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

describe('deriveUpsStatusContext', () => {
  it('returns all-null for null pkg', () => {
    expect(deriveUpsStatusContext(null)).toEqual({
      type: null,
      code: null,
      description: null
    })
  })

  it('returns all-null for undefined pkg', () => {
    expect(deriveUpsStatusContext(undefined)).toEqual({
      type: null,
      code: null,
      description: null
    })
  })

  it('falls back to currentStatus when activity is missing', () => {
    const pkg = {
      currentStatus: { type: 'D', code: '003', description: 'Delivered' }
    }
    expect(deriveUpsStatusContext(pkg)).toEqual({
      type: 'D',
      code: '003',
      description: 'Delivered'
    })
  })

  it('falls back to currentStatus when activity is empty array', () => {
    const pkg = {
      currentStatus: { type: 'I', code: '002', description: 'In Transit' },
      activity: []
    }
    expect(deriveUpsStatusContext(pkg)).toEqual({
      type: 'I',
      code: '002',
      description: 'In Transit'
    })
  })

  it('prefers newest activity status over a conflicting currentStatus', () => {
    const pkg = {
      currentStatus: { type: 'D', code: '003', description: 'Delivered' },
      activity: [
        {
          date: '20260720',
          time: '080000',
          status: { type: 'I', code: '002', description: 'In Transit' }
        }
      ]
    }
    // Activity says In Transit, currentStatus says Delivered — prefer activity
    expect(deriveUpsStatusContext(pkg)).toEqual({
      type: 'I',
      code: '002',
      description: 'In Transit'
    })
  })

  it('picks newest activity when array is out of order', () => {
    const pkg = {
      activity: [
        {
          date: '20260718',
          time: '120000',
          status: { type: 'I', code: '002', description: 'In Transit' }
        },
        {
          date: '20260720',
          time: '090000',
          status: { type: 'D', code: '003', description: 'Delivered' }
        },
        {
          date: '20260719',
          time: '150000',
          status: { type: 'O', code: '004', description: 'Out for Delivery' }
        }
      ]
    }
    // Latest is 20260720, even though it's index 1 in the array
    expect(deriveUpsStatusContext(pkg)).toEqual({
      type: 'D',
      code: '003',
      description: 'Delivered'
    })
  })

  it('handles same-date, later-time ordering', () => {
    const pkg = {
      activity: [
        {
          date: '20260720',
          time: '080000',
          status: { type: 'I', code: '002', description: 'Arrived at Facility' }
        },
        {
          date: '20260720',
          time: '143000',
          status: { type: 'D', code: '003', description: 'Delivered' }
        }
      ]
    }
    expect(deriveUpsStatusContext(pkg)).toEqual({
      type: 'D',
      code: '003',
      description: 'Delivered'
    })
  })

  it('description fallback: prefers status-level description over activity-level', () => {
    const pkg = {
      currentStatus: { type: 'D', code: '003', description: 'Status desc' },
      activity: [
        {
          date: '20260720',
          time: '080000',
          status: { type: 'D', code: '003' }, // no description on status
          description: 'Activity-level desc'
        }
      ]
    }
    const result = deriveUpsStatusContext(pkg)
    // src is latest.status (which has no description),
    // so fallback to latest.description
    expect(result.type).toBe('D')
    expect(result.code).toBe('003')
    expect(result.description).toBe('Activity-level desc')
  })

  it('description fallback: uses currentStatus.description as last resort', () => {
    const pkg = {
      currentStatus: { type: 'I', code: '002', description: 'Current desc' },
      activity: [
        {
          date: '20260720',
          time: '080000',
          status: { type: 'I', code: '002' } // no description
          // no activity-level description either
        }
      ]
    }
    const result = deriveUpsStatusContext(pkg)
    expect(result.type).toBe('I')
    expect(result.code).toBe('002')
    expect(result.description).toBe('Current desc')
  })

  it('handles activity entries with missing status field gracefully', () => {
    const pkg = {
      currentStatus: { type: 'I', code: '002', description: 'In Transit' },
      activity: [
        {
          date: '20260720',
          time: '080000'
          // no status key at all
        }
      ]
    }
    const result = deriveUpsStatusContext(pkg)
    // latest.status is undefined, so falls back to currentStatus
    expect(result.type).toBe('I')
    expect(result.code).toBe('002')
    expect(result.description).toBe('In Transit')
  })

  it('returns null type/code when nothing is available', () => {
    const pkg = {
      activity: [
        {
          date: '20260720',
          time: '080000'
          // no status, no description
        }
      ]
    }
    expect(deriveUpsStatusContext(pkg)).toEqual({
      type: null,
      code: null,
      description: null
    })
  })

  it('handles null activity (not an array)', () => {
    const pkg = {
      currentStatus: { type: 'D', code: '003', description: 'Delivered' },
      activity: null
    }
    expect(deriveUpsStatusContext(pkg)).toEqual({
      type: 'D',
      code: '003',
      description: 'Delivered'
    })
  })
})

describe('isStaleDelivery', () => {
  // --- Delivery strictly before createdAt → stale ---
  it('returns true when delivery is strictly before createdAt (different day)', () => {
    // delivery: 2026-05-12, createdAt: 2026-07-16
    expect(isStaleDelivery('20260512', new Date('2026-07-16T00:00:00Z'))).toBe(true)
  })

  it('returns true for delivery YYYYMMDD string before createdAt Date', () => {
    expect(isStaleDelivery('20260101', new Date('2026-01-02T00:00:00Z'))).toBe(true)
  })

  it('returns true when createdAt is an ISO string', () => {
    expect(isStaleDelivery('20260512', '2026-07-16T00:00:00Z')).toBe(true)
  })

  // --- Same calendar day → NOT stale ---
  it('returns false when delivery and createdAt share the same calendar day', () => {
    expect(isStaleDelivery('20260716', new Date('2026-07-16T15:30:00Z'))).toBe(false)
  })

  it('returns false when delivery is on the same day regardless of time', () => {
    expect(isStaleDelivery('20260716', new Date('2026-07-16T23:59:59Z'))).toBe(false)
  })

  // --- Delivery after createdAt → NOT stale ---
  it('returns false when delivery is after createdAt', () => {
    expect(isStaleDelivery('20260720', new Date('2026-07-16T00:00:00Z'))).toBe(false)
  })

  it('returns false when delivery is day after createdAt', () => {
    expect(isStaleDelivery('20260717', new Date('2026-07-16T00:00:00Z'))).toBe(false)
  })

  // --- Missing/invalid deliveryDate → false ---
  it('returns false for null deliveryDate', () => {
    expect(isStaleDelivery(null, new Date('2026-07-16T00:00:00Z'))).toBe(false)
  })

  it('returns false for undefined deliveryDate', () => {
    expect(isStaleDelivery(undefined, new Date('2026-07-16T00:00:00Z'))).toBe(false)
  })

  it('returns false for empty string deliveryDate', () => {
    expect(isStaleDelivery('', new Date('2026-07-16T00:00:00Z'))).toBe(false)
  })

  it('returns false for non-date string deliveryDate', () => {
    expect(isStaleDelivery('garbage', new Date('2026-07-16T00:00:00Z'))).toBe(false)
  })

  // --- Missing createdAt → false ---
  it('returns false for null createdAt', () => {
    expect(isStaleDelivery('20260512', null)).toBe(false)
  })

  it('returns false for undefined createdAt', () => {
    expect(isStaleDelivery('20260512', undefined)).toBe(false)
  })

  // --- Firestore Timestamp createdAt ---
  it('handles Firestore Timestamp with toDate() method', () => {
    const ts = {
      toDate: () => new Date('2026-07-16T00:00:00Z')
    }
    expect(isStaleDelivery('20260512', ts)).toBe(true)
  })

  // --- { _seconds } createdAt ---
  it('handles { _seconds } plain object createdAt', () => {
    // 2026-07-16T00:00:00Z = 1784246400 seconds since epoch
    const sec = Math.floor(new Date('2026-07-16T00:00:00Z').getTime() / 1000)
    // delivery 2026-05-12 is before 2026-07-16
    expect(isStaleDelivery('20260512', { _seconds: sec })).toBe(true)
  })

  it('handles { _seconds } with same-day delivery', () => {
    // 2026-07-16T12:00:00Z
    const sec = Math.floor(new Date('2026-07-16T12:00:00Z').getTime() / 1000)
    expect(isStaleDelivery('20260716', { _seconds: sec })).toBe(false)
  })

  // --- Date object deliveryDate ---
  it('accepts Date object for deliveryDate', () => {
    expect(
      isStaleDelivery(
        new Date('2026-05-12T00:00:00Z'),
        new Date('2026-07-16T00:00:00Z')
      )
    ).toBe(true)
  })

  it('accepts Date object for deliveryDate — same day', () => {
    expect(
      isStaleDelivery(
        new Date('2026-07-16T12:00:00Z'),
        new Date('2026-07-16T08:00:00Z')
      )
    ).toBe(false)
  })

  // --- Both missing/invalid → false ---
  it('returns false when both are null', () => {
    expect(isStaleDelivery(null, null)).toBe(false)
  })

  it('returns false when both are undefined', () => {
    expect(isStaleDelivery(undefined, undefined)).toBe(false)
  })

  // --- Graceful: invalid Date object ---
  it('returns false for invalid Date deliveryDate', () => {
    expect(isStaleDelivery(new Date('invalid'), new Date('2026-07-16T00:00:00Z'))).toBe(false)
  })
})
